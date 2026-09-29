import { parseRoute, type Route } from "./route";

/** Reactive current route, driven by `hashchange`. */
class Router {
  current: Route = $state(parseRoute(window.location.hash));

  constructor() {
    window.addEventListener("hashchange", () => {
      this.current = parseRoute(window.location.hash);
    });
  }
}

export const router = new Router();
