import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  // Generated, bundled and compressed runtime payloads are verified by their
  // builders and package hashes. Lint their source modules, not emitted bytes.
  { ignores: ["runtime/**", ".tmp-*/**", ".artifacts/**"] },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
