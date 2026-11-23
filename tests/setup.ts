// Chaves geradas só para testes. Nunca use estes valores fora da suíte.
process.env.CF_CHAVES_DADOS ??= `1:${Buffer.alloc(32, 1).toString("base64")},2:${Buffer.alloc(32, 2).toString("base64")}`;
process.env.CF_CHAVE_DADOS_ATIVA ??= "2";
process.env.CF_CHAVE_INDICE ??= Buffer.alloc(32, 9).toString("base64");
process.env.DATABASE_URL ??= "postgres://cf_app:senha-local-de-teste-1234567890@localhost:5432/consultafacil_test";
process.env.CF_DOMINIO_BASE ??= "consultafacil.test";
