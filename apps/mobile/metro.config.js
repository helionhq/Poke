// Expo configures monorepos itself (SDK 52+): workspace packages, a single react/react-native.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
