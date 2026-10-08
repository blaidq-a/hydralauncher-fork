const loggerStubUrl = `data:text/javascript,${encodeURIComponent(
  "export const logger = new Proxy({}, { get: () => () => undefined });"
)}`;

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "../logger.js" &&
    context.parentURL?.endsWith(
      "/src/main/services/download/js-http-downloader.ts"
    )
  ) {
    return { url: loggerStubUrl, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
