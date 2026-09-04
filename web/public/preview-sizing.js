export function normalizePreviewViewport(value) {
  if (!value || typeof value !== "object") return null;
  const width = Number(value.width), height = Number(value.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  return { width: Math.round(Math.max(160, Math.min(3840, width))), height: Math.round(Math.max(120, Math.min(2160, height))) };
}

export function previewFit(viewport, available) {
  const { width, height } = normalizePreviewViewport(viewport) ?? { width: 1280, height: 720 };
  const scale = Math.min(1, Math.max(0.01, Math.min(available.width / width, available.height / height)));
  return { width, height, scale, fittedWidth: width * scale, fittedHeight: height * scale };
}
