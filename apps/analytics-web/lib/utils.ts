/**
 * cn() — merge Tailwind class strings, dedupe + resolve conflicts.
 * Standard shadcn helper; used by every shadcn primitive.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
