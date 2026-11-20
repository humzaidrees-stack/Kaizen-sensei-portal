// Node request handler shared by the local server and the Vercel functions.
import { dispatch } from './routes.js';
import { HttpError, send } from './http.js';

export async function handle(req, res) {
  try {
    await dispatch(req, res);
  } catch (err) {
    if (res.headersSent) return;
    const known = err instanceof HttpError;
    if (!known) console.error(err);
    const payload = { error: known ? err.message : 'Something went wrong.' };
    if (known && err.code) payload.code = err.code;
    send(res, known ? err.status : 500, payload);
  }
}
