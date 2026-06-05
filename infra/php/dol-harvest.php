<?php
/**
 * dol-harvest.php — daily DOL LCA-release checker, to run as a CRON on a
 * non-AWS host (DOL's WAF blocks AWS IP ranges, so this can't run on Lambda/EC2).
 *
 * Each run:
 *   1. Fetch the DOL OFLC performance page (reachable from a normal host).
 *   2. Find the H-1B LCA *Disclosure* files (filing_year >= START_YEAR) and the
 *      newest "YYYY-Q" (annual files count as Q4 — the files are cumulative, so
 *      the newest is a superset of the quarter).
 *   3. If that's newer than the last value we processed (a local state file),
 *      download it (streamed to a temp file), upload it to the S3 inbox
 *      (streamed), and fire the EventBridge `lca.manual / build.run` event that
 *      triggers the burst.
 *
 * Cron (daily):  0 13 * * *  /usr/bin/php /path/dol-harvest.php >> /path/dol-harvest.log 2>&1
 *
 * IAM: create ONE dedicated key with a minimal policy —
 *   s3:PutObject on  <bucket>/incoming/*   and   events:PutEvents  on the default bus.
 * Put the key/secret in env (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) or below.
 *
 * Requires: PHP 7.4+ with curl + hash (both ubiquitous). Streams large files so
 * it stays within shared-hosting memory limits.
 */

// ----------------------------- CONFIG --------------------------------------
$AWS_REGION   = 'us-east-1';
$AWS_KEY      = getenv('AWS_ACCESS_KEY_ID')     ?: 'AKIA...';
$AWS_SECRET   = getenv('AWS_SECRET_ACCESS_KEY') ?: 'PUT_SECRET';
$S3_BUCKET    = 'lcasharedstack-ingestscratchbucket64251afd-XXXX'; // the ingest-scratch bucket
$S3_PREFIX    = 'incoming/';                                        // the burst reads from here
$DOL_URL      = 'https://www.dol.gov/agencies/eta/foreign-labor/performance';
$START_YEAR   = 2020;                                               // matches the burst's HARVEST_START_YEAR
$FILE_REGEX   = '/LCA_Disclosure_Data_FY(20\d{2})/i';              // capture group 1 = year
$STATE_FILE   = __DIR__ . '/dol-harvest.state';                    // last processed "YYYY-Q"
$USER_AGENT   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// One cookie jar shared across the page fetch + the file download — Akamai sets
// a bot-clearance cookie on the page request that the file request needs too.
$COOKIE_JAR   = sys_get_temp_dir() . '/dol-harvest-cookies.txt';
// ---------------------------------------------------------------------------

function logmsg($m) { echo '[' . gmdate('Y-m-d\TH:i:s\Z') . '] ' . $m . "\n"; }

/** A realistic browser header set (for accessing the public DOL data page). */
function browser_headers() {
    return [
        'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language: en-US,en;q=0.9',
        'Upgrade-Insecure-Requests: 1',
        'Sec-Fetch-Dest: document',
        'Sec-Fetch-Mode: navigate',
        'Sec-Fetch-Site: none',
        'Sec-Fetch-User: ?1',
        'sec-ch-ua: "Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile: ?0',
        'sec-ch-ua-platform: "Windows"',
    ];
}

/** GET text (page HTML). Returns [status, body]. (curl_close is a no-op in PHP 8+.) */
function http_get_text($url, $ua, $cookieJar) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => 120, CURLOPT_USERAGENT => $ua,
        CURLOPT_ENCODING => '',                          // accept gzip/br, auto-decompress
        CURLOPT_COOKIEJAR => $cookieJar,                  // persist the clearance cookie
        CURLOPT_COOKIEFILE => $cookieJar,
        CURLOPT_HTTPHEADER => browser_headers(),
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    return [$code, $body];
}

/** Stream a URL to a local file. Returns http status. */
function http_download($url, $ua, $destPath, $cookieJar, $referer) {
    $fp = fopen($destPath, 'wb');
    $ch = curl_init($url);
    $hdrs = browser_headers();
    $hdrs[] = 'Referer: ' . $referer;
    curl_setopt_array($ch, [
        CURLOPT_FILE => $fp, CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT => 1200, CURLOPT_USERAGENT => $ua,
        CURLOPT_ENCODING => '',
        CURLOPT_COOKIEJAR => $cookieJar,
        CURLOPT_COOKIEFILE => $cookieJar,                 // send the cookie set on the page
        CURLOPT_HTTPHEADER => $hdrs,
    ]);
    curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    fclose($fp);
    return $code;
}

function parse_quarter($name) {
    return preg_match('/_Q([1-4])/i', $name, $m) ? (int)$m[1] : 4; // annual = Q4
}

/**
 * AWS SigV4 request. $payload is either a string, or ['file' => path] to stream.
 * Returns [status, body].
 */
function aws_request($method, $service, $host, $uri, $headers, $payload, $region, $key, $secret) {
    $isFile = is_array($payload) && isset($payload['file']);
    $payloadHash = $isFile ? hash_file('sha256', $payload['file']) : hash('sha256', $payload);

    $amzdate = gmdate('Ymd\THis\Z');
    $datestamp = gmdate('Ymd');
    $headers['host'] = $host;
    $headers['x-amz-date'] = $amzdate;
    $headers['x-amz-content-sha256'] = $payloadHash;
    ksort($headers);

    $canonicalHeaders = ''; $signed = [];
    foreach ($headers as $k => $v) { $lk = strtolower($k); $canonicalHeaders .= "$lk:" . trim($v) . "\n"; $signed[] = $lk; }
    $signedStr = implode(';', $signed);

    $canonicalRequest = "$method\n$uri\n\n$canonicalHeaders\n$signedStr\n$payloadHash";
    $scope = "$datestamp/$region/$service/aws4_request";
    $stringToSign = "AWS4-HMAC-SHA256\n$amzdate\n$scope\n" . hash('sha256', $canonicalRequest);

    $kDate    = hash_hmac('sha256', $datestamp, 'AWS4' . $secret, true);
    $kRegion  = hash_hmac('sha256', $region, $kDate, true);
    $kService = hash_hmac('sha256', $service, $kRegion, true);
    $kSigning = hash_hmac('sha256', 'aws4_request', $kService, true);
    $signature = hash_hmac('sha256', $stringToSign, $kSigning);

    $curlHeaders = ["Authorization: AWS4-HMAC-SHA256 Credential=$key/$scope, SignedHeaders=$signedStr, Signature=$signature"];
    foreach ($headers as $k => $v) { $curlHeaders[] = "$k: $v"; }

    $ch = curl_init("https://$host$uri");
    $opts = [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $curlHeaders,
             CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 1200];
    if ($isFile) {
        $fp = fopen($payload['file'], 'rb');
        $opts[CURLOPT_PUT] = true;
        $opts[CURLOPT_INFILE] = $fp;
        $opts[CURLOPT_INFILESIZE] = filesize($payload['file']);
    } else {
        $opts[CURLOPT_POSTFIELDS] = $payload;
    }
    curl_setopt_array($ch, $opts);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    if (isset($fp)) fclose($fp);
    return [$code, $body];
}

// ============================ MAIN =========================================
[$code, $html] = http_get_text($DOL_URL, $USER_AGENT, $COOKIE_JAR);
if ($code !== 200 || !$html) { logmsg("DOL fetch failed (HTTP $code) — aborting, no state change."); exit(1); }

preg_match_all('/href="([^"]+\.xlsx)"/i', $html, $m);
$best = null;
foreach ($m[1] as $href) {
    $name = basename($href);
    if (!preg_match($FILE_REGEX, $name, $pm)) continue;
    $year = (int)$pm[1];
    if ($year < $START_YEAR) continue;
    $mark = sprintf('%04d-%d', $year, parse_quarter($name));
    $url  = (strpos($href, 'http') === 0) ? $href : 'https://www.dol.gov' . $href;
    if ($best === null || $mark > $best['mark']) $best = ['mark' => $mark, 'url' => $url, 'name' => $name];
}
if ($best === null) { logmsg("No in-scope LCA Disclosure files found (page changed/blocked or pattern off)."); exit(1); }

$state = is_file($STATE_FILE) ? trim(file_get_contents($STATE_FILE)) : '0000-0';
logmsg("newest on page: {$best['mark']} ({$best['name']}); last processed: $state");
if ($best['mark'] <= $state) { logmsg("No new release. Done."); exit(0); }

// New release — stream-download the (cumulative) newest file to a temp file.
$tmp = sys_get_temp_dir() . '/' . $best['name'];
logmsg("New release. Downloading {$best['url']} -> $tmp");
$dc = http_download($best['url'], $USER_AGENT, $tmp, $COOKIE_JAR, $DOL_URL);
if ($dc !== 200 || !is_file($tmp) || filesize($tmp) === 0) { logmsg("Download failed (HTTP $dc)."); @unlink($tmp); exit(1); }
logmsg('Downloaded ' . number_format(filesize($tmp)) . ' bytes.');

// Stream-upload to the S3 inbox.
$key = $S3_PREFIX . $best['name'];
[$uc, $ub] = aws_request('PUT', 's3', "$S3_BUCKET.s3.$AWS_REGION.amazonaws.com", '/' . $key,
    ['content-type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['file' => $tmp], $AWS_REGION, $AWS_KEY, $AWS_SECRET);
@unlink($tmp);
if ($uc < 200 || $uc >= 300) { logmsg("S3 upload failed (HTTP $uc): $ub"); exit(1); }
logmsg("Uploaded to s3://$S3_BUCKET/$key");

// Trigger the burst (the existing ManualRunRule listens for lca.manual/build.run).
$detail = json_encode(['source' => 'php-harvest', 'file' => $best['name'], 's3key' => $key, 'release' => $best['mark']]);
$eventBody = json_encode(['Entries' => [['Source' => 'lca.manual', 'DetailType' => 'build.run', 'Detail' => $detail]]]);
[$ec, $eb] = aws_request('POST', 'events', "events.$AWS_REGION.amazonaws.com", '/',
    ['content-type' => 'application/x-amz-json-1.1', 'x-amz-target' => 'AWSEvents.PutEvents'],
    $eventBody, $AWS_REGION, $AWS_KEY, $AWS_SECRET);
if ($ec < 200 || $ec >= 300) { logmsg("PutEvents failed (HTTP $ec): $eb"); exit(1); }
logmsg("Triggered burst: $eb");

file_put_contents($STATE_FILE, $best['mark']); // persist only after full success
logmsg("State updated to {$best['mark']}. Done.");
