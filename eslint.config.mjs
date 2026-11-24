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
        {
          selector: "CallExpression[callee.property.name='query'] > BinaryExpression[operator='+']",
          message: "Use consultas parametrizadas ($1, $2...) em vez de concatenar SQL.",
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "HTML bruto abre caminho para XSS e roubo de dados da sessão. Renderize texto.",
        },
        {
          selector: "CallExpression[callee.object.name='console'] > Identifier[name=/^(erro|error|err|e|linha|linhas|row|rows|req|request|body|corpo|dados)$/]",
          message: "Não registre objetos inteiros no console; use logErro/logInfo de @/lib/log.",
        },
        {
          selector: "CallExpression[callee.object.name='Response'][callee.property.name='json'] > Identifier[name=/^(linha|linhas|row|rows|resultado)$/]",
          message: "Não devolva linhas do banco direto; projete com respostaSegura(esquema, dados).",
        },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
];

export default configuracao;
