import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __dirname = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: __dirname });

const configuracao = [
  { ignores: [".next/**", "node_modules/**", "coverage/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Proíbe SQL montado por concatenação de strings em chamadas de query.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='query'] > TemplateLiteral[expressions.length>0]",
          message: "Use consultas parametrizadas ($1, $2...) em vez de interpolar valores no SQL.",
        },
      ],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
];

export default configuracao;
