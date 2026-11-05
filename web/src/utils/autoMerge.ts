export function autoMergeReasonKey(reason: string | null | undefined): string {
  switch (reason) {
    case 'checks_failed': return 'extra.manualApprovalReasonChecksFailed';
    case 'checks_missing': return 'extra.manualApprovalReasonChecksMissing';
    case 'escalated': return 'extra.manualApprovalReasonEscalated';
    case 'chain_incomplete': return 'extra.manualApprovalReasonChainIncomplete';
    case 'merge_failed': return 'extra.manualApprovalReasonMergeFailed';
    case 'auto_merge_disabled': return 'extra.manualApprovalReasonDisabled';
    default: return 'extra.manualApprovalReasonUnknown';
  }
}
