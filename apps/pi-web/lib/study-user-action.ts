import { isApiRequestAllowed } from "./request-security";

/** Browser mutation channel; scoped model tools call Host services and cannot mint this route's user event. */
export function isStudyBrowserMutation(request: Request): boolean {
  return request.method === "POST" && isApiRequestAllowed(request)
    && request.headers.has("origin")
    && request.headers.get("sec-fetch-site") === "same-origin"
    && ["cors", "same-origin"].includes(request.headers.get("sec-fetch-mode") ?? "");
}
