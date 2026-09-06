const DEFAULT_LATEST_THRESHOLD = 100;

function scrollMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function transcriptNearLatest(metrics, threshold = DEFAULT_LATEST_THRESHOLD) {
  const remaining = Math.max(0,
    scrollMetric(metrics?.scrollHeight)
      - scrollMetric(metrics?.scrollTop)
      - scrollMetric(metrics?.clientHeight));
  return remaining < Math.max(0, scrollMetric(threshold));
}

export function transcriptNeedsLatestButton(metrics, hasThread) {
  const scrollHeight = scrollMetric(metrics?.scrollHeight);
  const clientHeight = scrollMetric(metrics?.clientHeight);
  return Boolean(hasThread && scrollHeight > clientHeight + 1 && !transcriptNearLatest(metrics));
}
