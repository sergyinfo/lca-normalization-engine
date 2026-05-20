/**
 * Billing alerts + budget caps.
 *
 * Stack-of-its-own so you can destroy + recreate the alert wiring without
 * touching real resources. Three layers of protection:
 *
 *   1. AWS Budgets with multi-threshold actual + forecasted alerts
 *      - Monthly total (catches the obvious "what happened?" case)
 *      - Per-component (serve / data-pipeline) once cost-allocation tags
 *        are activated — see infra/aws/README.md
 *      - Quarterly burst (a runaway data-ops run that should have cost $5
 *        but is now $50)
 *      - Annual cap (sanity ceiling over the whole project)
 *   2. Cost Anomaly Detection — free, ML-based, catches spikes that don't
 *      hit a fixed threshold (e.g. a 10x increase from $1/day to $10/day
 *      still doesn't trip a $20/month budget for 15 days)
 *   3. SNS topic for delivery — currently emails, future webhook
 *
 * Configure via env vars at synth time:
 *   LCA_BILLING_EMAIL         — where to deliver alerts (required for email)
 *   LCA_MONTHLY_BUDGET_USD    — default 20
 *   LCA_BURST_BUDGET_USD      — default 50 (per-build cap)
 *   LCA_ANNUAL_BUDGET_USD     — default 150
 *   LCA_COMPONENT_BUDGET_USD  — default 10 (each of serve / data-pipeline)
 *   LCA_ANOMALY_THRESHOLD_USD — default 5
 */

import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';

const PROJECT_TAG_VALUE = 'h1b-report';

export interface BudgetsStackProps extends StackProps {
  alertEmail?: string;
  monthlyBudgetUsd?: number;
  burstBudgetUsd?: number;
  annualBudgetUsd?: number;
  componentBudgetUsd?: number;
  anomalyThresholdUsd?: number;
}

export class LcaBudgetsStack extends Stack {
  constructor(scope: Construct, id: string, props: BudgetsStackProps = {}) {
    super(scope, id, props);
    Tags.of(this).add('Component', 'billing');

    const monthly      = props.monthlyBudgetUsd      ?? Number(process.env.LCA_MONTHLY_BUDGET_USD     ?? 20);
    const burst        = props.burstBudgetUsd        ?? Number(process.env.LCA_BURST_BUDGET_USD       ?? 50);
    const annual       = props.annualBudgetUsd       ?? Number(process.env.LCA_ANNUAL_BUDGET_USD      ?? 150);
    const component    = props.componentBudgetUsd    ?? Number(process.env.LCA_COMPONENT_BUDGET_USD   ?? 10);
    const anomalyTrigger = props.anomalyThresholdUsd ?? Number(process.env.LCA_ANOMALY_THRESHOLD_USD ?? 5);
    const alertEmail   = props.alertEmail            ?? process.env.LCA_BILLING_EMAIL;

    // ---------------------------------------------------------------------
    // SNS topic for billing alerts. Decoupled from the build-pipeline
    // notification topic so noisy build notifications don't dull the
    // user's response to a real billing emergency.
    // ---------------------------------------------------------------------
    const alertTopic = new sns.Topic(this, 'BillingAlertsTopic', {
      displayName: 'LCA billing alerts',
    });

    if (alertEmail) {
      alertTopic.addSubscription(new subs.EmailSubscription(alertEmail));
    }

    // AWS Budgets sends emails on its own (no SNS hop needed). We also
    // route alerts through SNS so we can fan-out to Slack/PagerDuty later
    // without re-deploying budgets.
    const subscribers = (extra: string[] = []) => [
      { subscriptionType: 'SNS', address: alertTopic.topicArn },
      ...(alertEmail
        ? [{ subscriptionType: 'EMAIL', address: alertEmail }]
        : []),
      ...extra.map((address) => ({ subscriptionType: 'EMAIL', address })),
    ];

    // Common notification ladder: 50% / 80% / 100% actual + 100% forecast.
    const standardNotifications = (amount: number) => [
      {
        notification: {
          notificationType:   'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold:          50,
          thresholdType:      'PERCENTAGE',
        },
        subscribers: subscribers(),
      },
      {
        notification: {
          notificationType:   'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold:          80,
          thresholdType:      'PERCENTAGE',
        },
        subscribers: subscribers(),
      },
      {
        notification: {
          notificationType:   'ACTUAL',
          comparisonOperator: 'GREATER_THAN',
          threshold:          100,
          thresholdType:      'PERCENTAGE',
        },
        subscribers: subscribers(),
      },
      // Forecasted: AWS predicts month-end will exceed the limit; gives
      // an earlier warning than waiting for ACTUAL to cross.
      {
        notification: {
          notificationType:   'FORECASTED',
          comparisonOperator: 'GREATER_THAN',
          threshold:          100,
          thresholdType:      'PERCENTAGE',
        },
        subscribers: subscribers(),
      },
    ];

    // ---------------------------------------------------------------------
    // 1. Monthly total — every dollar tagged Project=h1b-report
    // ---------------------------------------------------------------------
    new budgets.CfnBudget(this, 'MonthlyTotalBudget', {
      budget: {
        budgetName: 'lca-monthly-total',
        budgetType: 'COST',
        timeUnit:   'MONTHLY',
        budgetLimit: { amount: monthly, unit: 'USD' },
        // Filters by the project-wide cost-allocation tag. Requires the
        // `Project` tag to be Active in Billing Console; see README §Tagging.
        costFilters: {
          TagKeyValue: [`user:Project$${PROJECT_TAG_VALUE}`],
        },
      },
      notificationsWithSubscribers: standardNotifications(monthly),
    });

    // ---------------------------------------------------------------------
    // 2. Per-component budgets — serve vs data-pipeline split
    // ---------------------------------------------------------------------
    for (const componentName of ['serve', 'data-pipeline'] as const) {
      new budgets.CfnBudget(this, `${componentName.replace('-', '')}MonthlyBudget`, {
        budget: {
          budgetName: `lca-monthly-${componentName}`,
          budgetType: 'COST',
          timeUnit:   'MONTHLY',
          budgetLimit: { amount: component, unit: 'USD' },
          costFilters: {
            TagKeyValue: [
              `user:Project$${PROJECT_TAG_VALUE}`,
              `user:Component$${componentName}`,
            ],
          },
        },
        notificationsWithSubscribers: standardNotifications(component),
      });
    }

    // ---------------------------------------------------------------------
    // 3. Quarterly burst budget — covers exactly one build run window.
    //    Not bound to AWS billing months. AWS Budgets supports QUARTERLY
    //    cadence which lines up neatly with DOL releases.
    // ---------------------------------------------------------------------
    new budgets.CfnBudget(this, 'QuarterlyBurstBudget', {
      budget: {
        budgetName: 'lca-quarterly-burst',
        budgetType: 'COST',
        timeUnit:   'QUARTERLY',
        budgetLimit: { amount: burst, unit: 'USD' },
        costFilters: {
          TagKeyValue: [
            `user:Project$${PROJECT_TAG_VALUE}`,
            `user:Component$data-pipeline`,
          ],
        },
      },
      notificationsWithSubscribers: standardNotifications(burst),
    });

    // ---------------------------------------------------------------------
    // 4. Annual cap — sanity ceiling
    // ---------------------------------------------------------------------
    new budgets.CfnBudget(this, 'AnnualCapBudget', {
      budget: {
        budgetName: 'lca-annual-cap',
        budgetType: 'COST',
        timeUnit:   'ANNUALLY',
        budgetLimit: { amount: annual, unit: 'USD' },
        costFilters: {
          TagKeyValue: [`user:Project$${PROJECT_TAG_VALUE}`],
        },
      },
      // Annual gets a less-noisy ladder — only 80% + 100% actual + forecast.
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType:   'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold:          80,
            thresholdType:      'PERCENTAGE',
          },
          subscribers: subscribers(),
        },
        {
          notification: {
            notificationType:   'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold:          100,
            thresholdType:      'PERCENTAGE',
          },
          subscribers: subscribers(),
        },
        {
          notification: {
            notificationType:   'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold:          100,
            thresholdType:      'PERCENTAGE',
          },
          subscribers: subscribers(),
        },
      ],
    });

    // ---------------------------------------------------------------------
    // 5. Cost Anomaly Detection — ML-based spike catcher.
    //    Catches "5x usual daily cost" even if it's still well under the
    //    monthly budget.
    // ---------------------------------------------------------------------
    const anomalyMonitor = new ce.CfnAnomalyMonitor(this, 'AnomalyMonitor', {
      monitorName: 'lca-anomaly-monitor',
      monitorType: 'CUSTOM',
      monitorSpecification: JSON.stringify({
        Tags: {
          Key: 'Project',
          Values: [PROJECT_TAG_VALUE],
        },
      }),
    });

    new ce.CfnAnomalySubscription(this, 'AnomalySubscription', {
      subscriptionName: 'lca-anomaly-alerts',
      frequency: 'IMMEDIATE',
      monitorArnList: [anomalyMonitor.attrMonitorArn],
      subscribers: [
        ...(alertEmail
          ? [{ type: 'EMAIL' as const, address: alertEmail }]
          : []),
        { type: 'SNS' as const, address: alertTopic.topicArn },
      ],
      threshold: anomalyTrigger,
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          MatchOptions: ['GREATER_THAN_OR_EQUAL'],
          Values: [String(anomalyTrigger)],
        },
      }),
    });

    // SNS topic policy: AWS Cost Anomaly Detection (costalerts.amazonaws.com)
    // and Budgets (budgets.amazonaws.com) both need permission to publish
    // to the topic. Without these statements, alerts silently drop.
    alertTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCostAnomalyDetectionPublish',
      actions: ['sns:Publish'],
      principals: [new iam.ServicePrincipal('costalerts.amazonaws.com')],
      resources: [alertTopic.topicArn],
    }));
    alertTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowBudgetsPublish',
      actions: ['sns:Publish'],
      principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
      resources: [alertTopic.topicArn],
    }));
  }
}
