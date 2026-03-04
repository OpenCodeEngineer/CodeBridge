import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "data/**"]
  },
  js.configs.recommended,
  {
    languageOptions: {
      globals: globals.node
    }
  }
];
