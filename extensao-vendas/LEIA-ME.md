# Extensão "Mais Acessível — Vendas e Atendimento"

Código-fonte da extensão publicada na Chrome Web Store
(ID `ojhkakepmgbmhnfoabkmmjbpilmhhmpj`).

## Como publicar uma atualização

1. Alterar os arquivos desta pasta.
2. **Aumentar a versão** em `manifest.json` (ex.: 2.1.2 → 2.1.3). A loja recusa versão repetida.
3. Enviar para a branch `main`.

A automação `.github/workflows/publicar-extensao.yml` empacota a pasta e envia para a
loja. O Google revisa (algumas horas a 1–2 dias) e os computadores atualizam sozinhos.

Credenciais (segredos do repositório): `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`.
