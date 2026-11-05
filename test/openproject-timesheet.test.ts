import { describe, expect, it } from 'vitest';
import { allocateTimesheetHours } from '../src/integrations/openproject/timesheet.js';

describe('OpenProject timesheet allocation', () => {
  it('keeps the configured total after minimum and rounding', () => {
    const result = allocateTimesheetHours([{ weight: 3 }, { weight: 2 }, { weight: 1 }], 8, 0.5, 0.25);
    expect(result.reduce((sum, value) => sum + value, 0)).toBe(8);
    expect(result.every((value) => value >= 0.5 && Math.round(value * 4) === value * 4)).toBe(true);
  });

  it('allows the total to exceed the day when minimums require it', () => {
    expect(allocateTimesheetHours([{ weight: 1 }, { weight: 1 }, { weight: 1 }], 8, 3, 0.25)).toEqual([3, 3, 3]);
  });
});
