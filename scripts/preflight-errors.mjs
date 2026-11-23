export function formatPreflightError(error, fallbackMessage) {
  return error instanceof Error ? error.message : fallbackMessage;
}

export function reportPreflightFailure(error, fallbackMessage) {
  console.error('::error::' + formatPreflightError(error, fallbackMessage));
  process.exitCode = 1;
}
