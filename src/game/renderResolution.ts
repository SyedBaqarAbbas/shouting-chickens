export function getCappedRenderResolution(pixelRatio: number) {
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    return 1;
  }

  return Math.min(2, Math.max(1, pixelRatio));
}
