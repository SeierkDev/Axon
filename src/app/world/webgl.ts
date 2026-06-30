// Detect whether the browser can actually give us a WebGL context. Some browsers
// have hardware acceleration / WebGL disabled (or a crashed GPU process), in which
// case Three.js throws an uncaught error and the canvas stays blank. We check up
// front so we can show a helpful message instead.
export function isWebGLAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl");
    return Boolean(gl);
  } catch {
    return false;
  }
}
