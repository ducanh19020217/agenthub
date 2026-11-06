/**
 * Chuẩn hoá tên gói tài khoản về một id ngắn để UI gắn tag (FREE, PLUS, PRO, MAX 20X…).
 * Trả null khi không nhận ra, để UI không hiện các chuỗi kỹ thuật như "stripe_subscription".
 */
export function normalizePlan(...sources: Array<string | null | undefined>): string | null {
  for (const raw of sources) {
    const value = (raw || '').toLowerCase();
    if (!value) continue;
    if (/max[_\s-]?20x/.test(value)) return 'max_20x';
    if (/max[_\s-]?5x/.test(value)) return 'max_5x';
    if (/\bmax\b|_max/.test(value)) return 'max';
    if (/ultra/.test(value)) return 'ultra';
    if (/enterprise/.test(value)) return 'enterprise';
    if (/business/.test(value)) return 'business';
    if (/\bteam\b|_team/.test(value)) return 'team';
    if (/\bedu\b|education/.test(value)) return 'edu';
    if (/\bpro\b|_pro/.test(value)) return 'pro';
    if (/\bplus\b/.test(value)) return 'plus';
    // Claude: tier mặc định của claude.ai là gói miễn phí (Cockpit tools cũng hiểu như vậy).
    if (/\bfree\b|free_tier|free-tier|^default_claude_ai$/.test(value)) return 'free';
  }
  return null;
}
