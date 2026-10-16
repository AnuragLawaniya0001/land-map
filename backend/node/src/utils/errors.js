export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const wrap = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  const detail = err.message || "Internal Server Error";
  if (status >= 500) {
    console.error("[livemap]", err);
  }
  res.status(status).json({ detail });
}
