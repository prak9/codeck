export function resolveViewportGeometry(viewport, fallbackHeight) {
  const visualHeight = Number(viewport?.height);
  const layoutHeight = Number(fallbackHeight);
  const offsetTop = Number(viewport?.offsetTop);
  const height = Number.isFinite(visualHeight) && visualHeight > 0
    ? visualHeight
    : Number.isFinite(layoutHeight) && layoutHeight > 0 ? layoutHeight : 0;
  return {
    height: Math.round(height),
    top: Math.max(0, Math.round(Number.isFinite(offsetTop) ? offsetTop : 0)),
  };
}
