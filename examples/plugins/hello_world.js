/**
 * Minimal plugin example — plain object export, no parameters.
 *
 * Copy to: ~/.lm-studio-toolbox/plugins/hello_world.js
 * Then restart the LM Studio Toolbox plugin.
 */
module.exports = {
  name: "hello_world",
  description: "Return a simple greeting. Used to verify the plugin system is working.",
  implementation: async () => {
    return { message: "Hello from a custom plugin!", timestamp: new Date().toISOString() };
  },
};
