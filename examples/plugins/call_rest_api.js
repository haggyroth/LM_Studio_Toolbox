/**
 * REST API caller — factory export so parameters can use Zod types.
 *
 * Replace BASE_URL and AUTH_TOKEN with your own values.
 * Copy to: ~/.lm-studio-toolbox/plugins/call_rest_api.js
 */

const BASE_URL   = "https://api.example.com";
const AUTH_TOKEN = process.env.MY_API_TOKEN ?? "";   // set in your shell profile

module.exports = function ({ z }) {
  return {
    name: "call_rest_api",
    description: "Make a GET or POST request to an internal REST API. Returns the parsed JSON response.",
    parameters: {
      path:    z.string().describe("API path, e.g. /users/42 or /orders?status=open"),
      method:  z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().default("GET"),
      body:    z.string().optional().describe("JSON body string for POST/PUT/PATCH requests"),
    },
    implementation: async ({ path, method = "GET", body }) => {
      const url = `${BASE_URL}${path}`;
      const headers = {
        "Content-Type": "application/json",
        ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
      };
      const res = await fetch(url, {
        method,
        headers,
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { status: res.status, ok: res.ok, data: parsed };
    },
  };
};
