const loggerStubUrl = `data:text/javascript,${encodeURIComponent(
  "export const logger = new Proxy({}, { get: () => () => undefined });"
)}`;

// Tests inject their own worker factory; the electron-vite worker import is
// only meaningful in the bundled app.
const nodeWorkerStubUrl = `data:text/javascript,${encodeURIComponent(
  "export default () => { throw new Error('nodeWorker is not available in tests'); };"
)}`;

const LOGGER_STUBBED_PARENTS = [
  "/src/main/services/download/js-http-downloader.ts",
  "/src/main/services/download/threaded-js-http-downloader.ts",
];

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier === "../logger.js" || specifier === "../logger") &&
    LOGGER_STUBBED_PARENTS.some((parent) => context.parentURL?.endsWith(parent))
  ) {
    return { url: loggerStubUrl, shortCircuit: true };
  }

  if (specifier.endsWith("?nodeWorker")) {
    return { url: nodeWorkerStubUrl, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
