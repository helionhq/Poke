import { DomainError, type DomainErrorCode, type Logger } from "@poke/domain";
import type { FastifyError, FastifyInstance } from "fastify";

const STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  invalid: 400,
  conflict: 409,
  forbidden: 403,
  unauthorized: 401,
  rate_limited: 429,
  no_model: 409,
  unavailable: 503,
};

export function installErrorHandler(app: FastifyInstance, log: Logger): void {
  app.setErrorHandler((error: FastifyError | DomainError | Error, req, reply) => {
    if (error instanceof DomainError) {
      const body: { error: { code: string; message: string; details?: Record<string, unknown> } } = {
        error: { code: error.code, message: error.message },
      };
      if (error.details) body.error.details = error.details;
      return reply.status(STATUS[error.code]).send(body);
    }
    const status = (error as FastifyError).statusCode ?? 500;
    if (status >= 500) log.error({ err: error, url: req.url }, "request failed");
    return reply.status(status).send({
      error: {
        code: status >= 500 ? "internal" : "bad_request",
        message: status >= 500 ? "Something broke on Poke's side" : error.message,
      },
    });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: "not_found", message: "No such route" } }),
  );
}
