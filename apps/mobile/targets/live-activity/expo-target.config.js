/**
 * The Live Activity extension (brief section 18, screen 08), added by @bacons/apple-targets at
 * prebuild. State reaches it only through ActivityKit content updates, so it needs no App Group
 * (free personal teams may not get one). Leave it out of a build with POKE_LIVE_ACTIVITY=0.
 *
 * @type {import('@bacons/apple-targets/app.plugin').ConfigFunction}
 */
module.exports = () => ({
  type: "widget",
  name: "PokeLiveActivity",
  displayName: "Poke",
  bundleIdentifier: ".live",
  deploymentTarget: "17.0",
  images: { PokeMark: "../../../../packages/ui-tokens/assets/agent-mark.jpg" },
});
