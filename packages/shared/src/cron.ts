/**
 * Zero-dependency 5-field UTC Cron Expression parser & next-run calculator.
 * Format: "<minute> <hour> <dayOfMonth> <month> <dayOfWeek>"
 * Supports: "*", "*\/N", "A", "A-B", "A,B,C", "A-B/N"
 */

export interface ParsedCron {
  expression: string;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseField(field: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  const parts = field.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`Empty segment in cron ${name} field`);

    const [rangePart, stepPart] = trimmed.split('/');
    const step = stepPart !== undefined ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid step "${stepPart}" in cron ${name} field`);
    }

    let start = min;
    let end = max;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [sStr, eStr] = rangePart.split('-');
      start = Number.parseInt(sStr, 10);
      end = Number.parseInt(eStr, 10);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        throw new Error(`Invalid range "${rangePart}" in cron ${name} field (${min}-${max})`);
      }
    } else {
      const val = Number.parseInt(rangePart, 10);
      if (!Number.isInteger(val) || val < min || val > max) {
        throw new Error(`Invalid value "${rangePart}" in cron ${name} field (${min}-${max})`);
      }
      start = val;
      end = stepPart !== undefined ? max : val;
    }

    for (let v = start; v <= end; v += step) {
      out.add(v);
    }
  }
  if (out.size === 0) {
    throw new Error(`Cron ${name} field matched no values`);
  }
  return out;
}

export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron expression must have exactly 5 fields: minute hour dayOfMonth month dayOfWeek');
  }
  return {
    expression: fields.join(' '),
    minutes: parseField(fields[0], 0, 59, 'minute'),
    hours: parseField(fields[1], 0, 23, 'hour'),
    daysOfMonth: parseField(fields[2], 1, 31, 'dayOfMonth'),
    months: parseField(fields[3], 1, 12, 'month'),
    daysOfWeek: parseField(fields[4], 0, 6, 'dayOfWeek'),
  };
}

export function matchesCronUtc(parsed: ParsedCron, date: Date): boolean {
  return (
    parsed.minutes.has(date.getUTCMinutes()) &&
    parsed.hours.has(date.getUTCHours()) &&
    parsed.daysOfMonth.has(date.getUTCDate()) &&
    parsed.months.has(date.getUTCMonth() + 1) &&
    parsed.daysOfWeek.has(date.getUTCDay())
  );
}

/**
 * Computes the next UTC execution timestamp strictly after `fromDate`.
 */
export function getNextCronDate(expression: string, fromDate: Date = new Date()): Date {
  const parsed = parseCronExpression(expression);
  const candidate = new Date(fromDate.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Search up to 366 days ahead (at most ~527,040 minutes, skipping fast by month/day/hour)
  const limit = new Date(fromDate.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (candidate <= limit) {
    if (!parsed.months.has(candidate.getUTCMonth() + 1)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.daysOfMonth.has(candidate.getUTCDate()) || !parsed.daysOfWeek.has(candidate.getUTCDay())) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hours.has(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minutes.has(candidate.getUTCMinutes())) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return candidate;
  }

  throw new Error(`No matching execution date found within 1 year for cron "${expression}"`);
}

export function validateCronExpression(expression: string): { valid: boolean; error?: string } {
  try {
    parseCronExpression(expression);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function getNextCronDates(expression: string, count = 5, fromDate: Date = new Date()): Date[] {
  const results: Date[] = [];
  let cursor = fromDate;
  for (let i = 0; i < count; i++) {
    const next = getNextCronDate(expression, cursor);
    results.push(next);
    cursor = next;
  }
  return results;
}

export function describeCron(expression: string): string {
  const norm = expression.trim().replace(/\s+/g, ' ');
  const presets: Record<string, string> = {
    '* * * * *': 'Every minute (UTC)',
    '*/5 * * * *': 'Every 5 minutes (UTC)',
    '*/15 * * * *': 'Every 15 minutes (UTC)',
    '*/30 * * * *': 'Every 30 minutes (UTC)',
    '0 * * * *': 'Every hour at :00 (UTC)',
    '0 0 * * *': 'Daily at 00:00 UTC',
    '0 9 * * 1-5': 'Weekdays at 09:00 UTC',
    '0 0 * * 0': 'Weekly on Sunday at 00:00 UTC',
    '0 0 1 * *': 'Monthly on the 1st at 00:00 UTC',
  };
  return presets[norm] ?? `Cron "${norm}" (UTC)`;
}
