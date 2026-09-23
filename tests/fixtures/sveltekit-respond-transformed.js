import { DEV } from "/node_modules/esm-env/index.js";
import { json, text } from "@sveltejs/kit";
import { Redirect, SvelteKitError } from "@sveltejs/kit/internal";
import { merge_tracing, with_request_store } from "@sveltejs/kit/internal/server";
import { base, app_dir } from "/node_modules/@sveltejs/kit/src/runtime/app/paths/internal/server.js";
import { is_endpoint_request, render_endpoint } from "/node_modules/@sveltejs/kit/src/runtime/server/endpoint.js";
import { render_page } from "/node_modules/@sveltejs/kit/src/runtime/server/page/index.js";
import { render_response } from "/node_modules/@sveltejs/kit/src/runtime/server/page/render.js";
import { respond_with_error } from "/node_modules/@sveltejs/kit/src/runtime/server/page/respond_with_error.js";
import { get_set_cookies, is_form_content_type } from "/node_modules/@sveltejs/kit/src/utils/http.js";
import {
  handle_fatal_error,
  has_prerendered_path,
  method_not_allowed,
  redirect_response
} from "/node_modules/@sveltejs/kit/src/runtime/server/utils.js";
import { decode_pathname, disable_search, normalize_path } from "/node_modules/@sveltejs/kit/src/utils/url.js";
import { find_route } from "/node_modules/@sveltejs/kit/src/utils/routing.js";
import { redirect_json_response, render_data } from "/node_modules/@sveltejs/kit/src/runtime/server/data/index.js";
import { add_cookies_to_headers, get_cookies } from "/node_modules/@sveltejs/kit/src/runtime/server/cookie.js";
import { create_fetch } from "/node_modules/@sveltejs/kit/src/runtime/server/fetch.js";
import { PageNodes } from "/node_modules/@sveltejs/kit/src/utils/page_nodes.js";
import { validate_server_exports } from "/node_modules/@sveltejs/kit/src/utils/exports.js";
import { action_json_redirect, is_action_json_request } from "/node_modules/@sveltejs/kit/src/runtime/server/page/actions.js";
import { INVALIDATED_PARAM, TRAILING_SLASH_PARAM } from "/node_modules/@sveltejs/kit/src/runtime/shared.js";
import { get_public_env } from "/node_modules/@sveltejs/kit/src/runtime/server/env_module.js";
import { resolve_route } from "/node_modules/@sveltejs/kit/src/runtime/server/page/server_routing.js";
import { validateHeaders } from "/node_modules/@sveltejs/kit/src/runtime/server/validate-headers.js";
import {
  add_data_suffix,
  add_resolution_suffix,
  has_data_suffix,
  has_resolution_suffix,
  strip_data_suffix,
  strip_resolution_suffix
} from "/node_modules/@sveltejs/kit/src/runtime/pathname.js";
import { server_data_serializer } from "/node_modules/@sveltejs/kit/src/runtime/server/page/data_serializer.js";
import { get_remote_id, handle_remote_call } from "/node_modules/@sveltejs/kit/src/runtime/server/remote.js";
import { record_span } from "/node_modules/@sveltejs/kit/src/runtime/telemetry/record_span.js";
import { otel } from "/node_modules/@sveltejs/kit/src/runtime/telemetry/otel.js";
const default_transform = ({ html }) => html;
const default_filter = () => false;
const default_preload = ({ type }) => type === "js" || type === "css";
const page_methods = /* @__PURE__ */ new Set(["GET", "HEAD", "POST"]);
const allowed_page_methods = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS"]);
export const respond = propagate_context(internal_respond);
export async function internal_respond(request, options, manifest, state) {
  const url = new URL(request.url);
  const is_route_resolution_request = has_resolution_suffix(url.pathname);
  const is_data_request = has_data_suffix(url.pathname);
  const remote_id = get_remote_id(url);
  if (false) {
    const request_origin = request.headers.get("origin");
    if (remote_id) {
      if (request.method !== "GET" && request_origin !== url.origin) {
        const message = "Cross-site remote requests are forbidden";
        return json({ message }, { status: 403 });
      }
    } else if (options.csrf_check_origin) {
      const forbidden = is_form_content_type(request) && (request.method === "POST" || request.method === "PUT" || request.method === "PATCH" || request.method === "DELETE") && request_origin !== url.origin && (!request_origin || !options.csrf_trusted_origins.includes(request_origin));
      if (forbidden) {
        const message = `Cross-site ${request.method} form submissions are forbidden`;
        const opts = { status: 403 };
        if (request.headers.get("accept") === "application/json") {
          return json({ message }, opts);
        }
        return text(message, opts);
      }
    }
  }
  if (options.hash_routing && url.pathname !== base + "/" && url.pathname !== "/[fallback]") {
    return text("Not found", { status: 404 });
  }
  let invalidated_data_nodes;
  if (is_route_resolution_request) {
    url.pathname = strip_resolution_suffix(url.pathname);
  } else if (is_data_request) {
    url.pathname = strip_data_suffix(url.pathname) + (url.searchParams.get(TRAILING_SLASH_PARAM) === "1" ? "/" : "") || "/";
    url.searchParams.delete(TRAILING_SLASH_PARAM);
    invalidated_data_nodes = url.searchParams.get(INVALIDATED_PARAM)?.split("").map((node) => node === "1");
    url.searchParams.delete(INVALIDATED_PARAM);
  } else if (remote_id) {
    url.pathname = request.headers.get("x-sveltekit-pathname") ?? base;
    url.search = request.headers.get("x-sveltekit-search") ?? "";
  }
  const headers = {};
  const { cookies, new_cookies, get_cookie_header, set_internal, set_trailing_slash } = get_cookies(
    request,
    url
  );
  const event_state = {
    prerendering: state.prerendering,
    transport: options.hooks.transport,
    handleValidationError: options.hooks.handleValidationError,
    tracing: {
      record_span
    },
    remote: {
      data: null,
      explicit: null,
      implicit: null,
      forms: null,
      requested: null,
      batches: null,
      live_iterators: null
    },
    is_in_remote_function: false,
    is_in_remote_form_or_command: false,
    is_in_remote_query: false,
    is_in_render: false,
    is_in_universal_load: false
  };
  const event = {
    cookies,
    // @ts-expect-error `fetch` needs to be created after the `event` itself
    fetch: null,
    getClientAddress: state.getClientAddress || (() => {
      throw new Error(
        `${__SVELTEKIT_ADAPTER_NAME__} does not specify getClientAddress. Please raise an issue`
      );
    }),
    locals: {},
    params: {},
    platform: state.platform,
    request,
    route: { id: null },
    setHeaders: (new_headers) => {
      if (DEV) {
        validateHeaders(new_headers);
      }
      for (const key in new_headers) {
        const lower = key.toLowerCase();
        const value = new_headers[key];
        if (lower === "set-cookie") {
          throw new Error(
            "Use `event.cookies.set(name, value, options)` instead of `event.setHeaders` to set cookies"
          );
        } else if (lower in headers) {
          if (lower === "server-timing") {
            headers[lower] += ", " + value;
          } else {
            throw new Error(`"${key}" header is already set`);
          }
        } else {
          headers[lower] = value;
          if (state.prerendering && lower === "cache-control") {
            state.prerendering.cache = /** @type {string} */
            value;
          }
        }
      }
    },
    url,
    isDataRequest: is_data_request,
    isSubRequest: state.depth > 0,
    isRemoteRequest: !!remote_id
  };
  event.fetch = create_fetch({
    event,
    options,
    manifest,
    state,
    get_cookie_header,
    set_internal
  });
  if (state.emulator?.platform) {
    event.platform = await state.emulator.platform({
      config: {},
      prerender: !!state.prerendering?.fallback
    });
  }
  let resolved_path = url.pathname;
  if (!remote_id) {
    const prerendering_reroute_state = state.prerendering?.inside_reroute;
    try {
      if (state.prerendering) state.prerendering.inside_reroute = true;
      resolved_path = await options.hooks.reroute({ url: new URL(url), fetch: event.fetch }) ?? url.pathname;
    } catch {
      return text("Internal Server Error", {
        status: 500
      });
    } finally {
      if (state.prerendering) state.prerendering.inside_reroute = prerendering_reroute_state;
    }
  }
  let resolve_opts = {
    transformPageChunk: default_transform,
    filterSerializedResponseHeaders: default_filter,
    preload: default_preload
  };
  let trailing_slash = "never";
  let page_nodes;
  try {
    resolved_path = decode_pathname(resolved_path);
  } catch {
    resolved_path = null;
    return await handle();
  }
  if (
    // the resolved path has been decoded so it should be compared to the decoded url pathname
    resolved_path !== decode_pathname(url.pathname) && !state.prerendering?.fallback && has_prerendered_path(manifest, resolved_path)
  ) {
    const url2 = new URL(request.url);
    url2.pathname = is_data_request ? add_data_suffix(resolved_path) : is_route_resolution_request ? add_resolution_suffix(resolved_path) : resolved_path;
    try {
      const response = await fetch(url2, request);
      const headers2 = new Headers(response.headers);
      if (headers2.has("content-encoding")) {
        headers2.delete("content-encoding");
        headers2.delete("content-length");
      }
      return new Response(response.body, {
        headers: headers2,
        status: response.status,
        statusText: response.statusText
      });
    } catch (error) {
      return await handle_fatal_error(event, event_state, options, error);
    }
  }
  let route = null;
  if (base && !state.prerendering?.fallback) {
    if (!resolved_path.startsWith(base)) {
      return text("Not found", { status: 404 });
    }
    resolved_path = resolved_path.slice(base.length) || "/";
  }
  if (is_route_resolution_request) {
    return resolve_route(resolved_path, new URL(request.url), manifest);
  }
  if (resolved_path === `/${app_dir}/env.js` || resolved_path === `/${app_dir}/env.script.js`) {
    return get_public_env(request);
  }
  if (!remote_id && resolved_path.startsWith(`/${app_dir}`)) {
    const headers2 = new Headers();
    headers2.set("cache-control", "public, max-age=0, must-revalidate");
    return text("Not found", { status: 404, headers: headers2 });
  }
  if (!state.prerendering?.fallback) {
    const matchers = await manifest._.matchers();
    const result = find_route(resolved_path, manifest._.routes, matchers);
    if (result) {
      route = result.route;
      event.route = { id: route.id };
      event.params = result.params;
    }
  }
  try {
    page_nodes = route?.page ? new PageNodes(await load_page_nodes(route.page, manifest)) : void 0;
    if (route && !remote_id) {
      if (url.pathname === base || url.pathname === base + "/") {
        trailing_slash = "always";
      } else if (page_nodes) {
        if (DEV) {
          page_nodes.validate();
        }
        trailing_slash = page_nodes.trailing_slash();
      } else if (route.endpoint) {
        const node = await route.endpoint();
        trailing_slash = node.trailingSlash ?? "never";
        if (DEV) {
          validate_server_exports(
            node,
            /** @type {string} */
            route.endpoint_id
          );
        }
      }
      if (!is_data_request) {
        const normalized = normalize_path(url.pathname, trailing_slash);
        if (normalized !== url.pathname && !state.prerendering?.fallback) {
          return new Response(void 0, {
            status: 308,
            headers: {
              "x-sveltekit-normalize": "1",
              location: (
                // ensure paths starting with '//' are not treated as protocol-relative
                (normalized.startsWith("//") ? url.origin + normalized : normalized) + (url.search === "?" ? "" : url.search)
              )
            }
          });
        }
      }
      if (state.before_handle || state.emulator?.platform) {
        let config = {};
        let prerender = false;
        if (route.endpoint) {
          const node = await route.endpoint();
          config = node.config ?? config;
          prerender = node.prerender ?? prerender;
        } else if (page_nodes) {
          config = page_nodes.get_config() ?? config;
          prerender = page_nodes.prerender();
        }
        if (state.emulator?.platform) {
          event.platform = await state.emulator.platform({ config, prerender });
        }
        if (state.before_handle) {
          return await state.before_handle(event, config, prerender, handle);
        }
      }
    }
    return await handle();
  } catch (e) {
    if (e instanceof Redirect) {
      try {
        const response = is_data_request || remote_id ? redirect_json_response(e) : route?.page && is_action_json_request(event) ? action_json_redirect(e) : redirect_response(e.status, e.location);
        add_cookies_to_headers(response.headers, new_cookies.values());
        return response;
      } catch (err) {
        return await handle_fatal_error(event, event_state, options, err);
      }
    }
    return await handle_fatal_error(event, event_state, options, e);
  }
  async function handle() {
    set_trailing_slash(trailing_slash);
    if (state.prerendering && !state.prerendering.fallback && !state.prerendering.inside_reroute) {
      disable_search(url);
    }
    const response = await record_span({
      name: "sveltekit.handle.root",
      attributes: {
        "http.route": event.route.id || "unknown",
        "http.method": event.request.method,
        "http.url": event.url.href,
        "sveltekit.is_data_request": is_data_request,
        "sveltekit.is_sub_request": event.isSubRequest
      },
      fn: async (root_span) => {
        const traced_event = {
          ...event,
          tracing: {
            enabled: false,
            root: root_span,
            current: root_span
          }
        };
        return await with_request_store(
          { event: traced_event, state: event_state },
          () => options.hooks.handle({
            event: traced_event,
            resolve: (event2, opts) => {
              return record_span({
                name: "sveltekit.resolve",
                attributes: {
                  "http.route": event2.route.id || "unknown"
                },
                fn: (resolve_span) => {
                  return with_request_store(
                    null,
                    () => resolve(merge_tracing(event2, resolve_span), page_nodes, opts).then(
                      (response2) => {
                        for (const key in headers) {
                          const value = headers[key];
                          response2.headers.set(
                            key,
                            /** @type {string} */
                            value
                          );
                        }
                        add_cookies_to_headers(response2.headers, new_cookies.values());
                        if (state.prerendering && event2.route.id !== null) {
                          response2.headers.set("x-sveltekit-routeid", encodeURI(event2.route.id));
                        }
                        resolve_span.setAttributes({
                          "http.response.status_code": response2.status,
                          "http.response.body.size": response2.headers.get("content-length") || "unknown"
                        });
                        return response2;
                      }
                    )
                  );
                }
              });
            }
          })
        );
      }
    });
    if (response.status === 200 && response.headers.has("etag")) {
      let if_none_match_value = request.headers.get("if-none-match");
      if (if_none_match_value?.startsWith('W/"')) {
        if_none_match_value = if_none_match_value.substring(2);
      }
      const etag = (
        /** @type {string} */
        response.headers.get("etag")
      );
      if (if_none_match_value === etag) {
        const headers2 = new Headers({ etag });
        for (const key of ["cache-control", "content-location", "date", "expires", "vary"]) {
          const value = response.headers.get(key);
          if (value) headers2.set(key, value);
        }
        for (const cookie of get_set_cookies(response.headers)) {
          headers2.append("set-cookie", cookie);
        }
        return new Response(void 0, {
          status: 304,
          headers: headers2
        });
      }
    }
    if (is_data_request && response.status >= 300 && response.status <= 308) {
      const location = response.headers.get("location");
      if (location) {
        return redirect_json_response(new Redirect(
          /** @type {any} */
          response.status,
          location
        ));
      }
    }
    return response;
  }
  async function resolve(event2, page_nodes2, opts) {
    try {
      if (opts) {
        resolve_opts = {
          transformPageChunk: opts.transformPageChunk || default_transform,
          filterSerializedResponseHeaders: opts.filterSerializedResponseHeaders || default_filter,
          preload: opts.preload || default_preload
        };
      }
      if (resolved_path === null) {
        return await respond_with_error({
          event: event2,
          event_state,
          options,
          manifest,
          state,
          status: 400,
          error: new SvelteKitError(
            400,
            "Malformed URI",
            `Failed to decode URI: ${event2.url.pathname}`
          ),
          resolve_opts
        });
      }
      if (options.hash_routing || state.prerendering?.fallback) {
        return await render_response({
          event: event2,
          event_state,
          options,
          manifest,
          state,
          page_config: { ssr: false, csr: true },
          status: 200,
          error: null,
          branch: [
            // include the root layout because it applies to every page
            {
              node: (
                /** @type {SSRNode} */
                await manifest._.nodes[0]()
              ),
              data: null,
              server_data: null
            }
          ],
          fetched: [],
          resolve_opts,
          data_serializer: server_data_serializer(event2, event_state, options)
        });
      }
      if (remote_id) {
        return await handle_remote_call(event2, event_state, options, manifest, remote_id);
      }
      if (route) {
        const method = (
          /** @type {import('types').HttpMethod} */
          event2.request.method
        );
        let response2;
        if (is_data_request) {
          response2 = await render_data(
            event2,
            event_state,
            route,
            options,
            manifest,
            state,
            invalidated_data_nodes,
            trailing_slash
          );
        } else if (route.endpoint && (!route.page || !state.prerendering && is_endpoint_request(event2))) {
          response2 = await render_endpoint(event2, event_state, await route.endpoint(), state);
        } else if (route.page) {
          if (!page_nodes2) {
            throw new Error("page_nodes not found. This should never happen");
          } else if (page_methods.has(method)) {
            response2 = await render_page(
              event2,
              event_state,
              route.page,
              options,
              manifest,
              state,
              page_nodes2,
              resolve_opts
            );
          } else {
            const allowed_methods = new Set(allowed_page_methods);
            const node = await manifest._.nodes[route.page.leaf]();
            if (node?.server?.actions) {
              allowed_methods.add("POST");
            }
            if (method === "OPTIONS") {
              response2 = new Response(null, {
                status: 204,
                headers: {
                  allow: Array.from(allowed_methods.values()).join(", ")
                }
              });
            } else {
              const mod = [...allowed_methods].reduce(
                (acc, curr) => {
                  acc[curr] = true;
                  return acc;
                },
                /** @type {Record<string, any>} */
                {}
              );
              response2 = method_not_allowed(mod, method);
            }
          }
        } else {
          throw new Error("Route is neither page nor endpoint. This should never happen");
        }
        if (request.method === "GET" && route.page && route.endpoint) {
          const vary = response2.headers.get("vary")?.split(",")?.map((v) => v.trim().toLowerCase());
          if (!(vary?.includes("accept") || vary?.includes("*"))) {
            response2 = new Response(response2.body, {
              status: response2.status,
              statusText: response2.statusText,
              headers: new Headers(response2.headers)
            });
            response2.headers.append("Vary", "Accept");
          }
        }
        return response2;
      }
      if (state.error && event2.isSubRequest) {
        const headers2 = new Headers(request.headers);
        headers2.set("x-sveltekit-error", "true");
        return await fetch(request, { headers: headers2 });
      }
      if (state.error) {
        return text("Internal Server Error", {
          status: 500
        });
      }
      if (state.depth === 0) {
        return await respond_with_error({
          event: event2,
          event_state,
          options,
          manifest,
          state,
          status: 404,
          error: new SvelteKitError(404, "Not Found", `Not found: ${event2.url.pathname}`),
          resolve_opts
        });
      }
      if (state.prerendering) {
        return text("not found", { status: 404 });
      }
      const response = await fetch(request);
      return new Response(response.body, response);
    } catch (e) {
      return await handle_fatal_error(event2, event_state, options, e);
    } finally {
      event2.cookies.set = () => {
        throw new Error("Cannot use `cookies.set(...)` after the response has been generated");
      };
      event2.setHeaders = () => {
        throw new Error("Cannot use `setHeaders(...)` after the response has been generated");
      };
    }
  }
}
export function load_page_nodes(page, manifest) {
  return Promise.all([
    // we use == here rather than === because [undefined] serializes as "[null]"
    ...page.layouts.map((n) => n == void 0 ? n : manifest._.nodes[n]()),
    manifest._.nodes[page.leaf]()
  ]);
}
function propagate_context(fn) {
  return async (req, ...rest) => {
    if (otel === null) {
      return fn(req, ...rest);
    }
    const { propagation, context } = await otel;
    const c = propagation.extract(context.active(), Object.fromEntries(req.headers));
    return context.with(c, async () => {
      return await fn(req, ...rest);
    });
  };
}
