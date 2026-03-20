# Roteiro de Gravacao de Tela -- Predix Demo Video

> Voce so precisa gravar 3 trechos de tela. O resto (intro, transicoes, closing) ja esta renderizado nos clips Remotion.
> Gravacao: 1920x1080, 60fps, tema escuro no browser e VS Code.

---

## ANTES DE GRAVAR -- Checklist

- [ ] Xverse conectada com saldo de pelo menos 20 USDCx
- [ ] predix.live aberto e funcionando (rounds resolvendo normalmente)
- [ ] Claude Desktop configurado com MCP server (testar antes)
- [ ] Hiro Explorer aberto na aba com o contrato predixv8
- [ ] GitHub do projeto aberto em outra aba
- [ ] VS Code aberto com o projeto carregado
- [ ] Resolucao: 1920x1080
- [ ] Fechar todas as notificacoes (Slack, Discord, email, sistema)
- [ ] Browser: barra de abas limpa, sem barra de favoritos, tema escuro
- [ ] VS Code: fonte tamanho 16-18px para legibilidade

---

## GRAVACAO 1: Demo ao Vivo (~60 segundos)

> Esse trecho vem depois do clip03-solves.mp4
> A narracao IA diz: "Every round lasts sixty seconds..."

### Preparacao

- Abra predix.live
- Espere um round novo comecar
- Comece a gravar quando o countdown estiver em ~50s (round acabou de abrir)

### Passo a passo

| Passo | O que fazer | Detalhe |
|-------|-------------|---------|
| 1 | **Mostre o MarketCard** | Deixe o cursor parado por 2-3s. O preco BTC esta pulsando, o countdown rodando. |
| 2 | **Passe o cursor sobre cada elemento** | Devagar: (1) preco BTC no topo, (2) countdown timer, (3) pool UP com valor, (4) pool DOWN com valor. |
| 3 | **Clique no botao UP** | Clique firme, sem pressa. |
| 4 | **Digite "5" no campo de valor** | Espere o campo aparecer, digite devagar. |
| 5 | **Mostre o gas = $0** | Passe o cursor sobre onde mostra "Sponsored" ou fee = 0. Pause 2s. |
| 6 | **Clique "Place Bet"** | Botao de confirmar aposta. |
| 7 | **Xverse aparece -- clique Confirm** | Nao tenha pressa. Mostre que e so assinar. |
| 8 | **Mostre o pool atualizando** | Sua aposta aparece no pool UP instantaneamente (update otimista). |
| 9 | **Espere o countdown chegar a 0** | Nao faca nada. Deixe o timer rodar. |
| 10 | **Round resolve** | Resultado aparece: UP venceu ou DOWN venceu. |
| 11 | **Mostre o payout** | Se ganhou, mostre a notificacao/saldo. Se perdeu, tudo bem -- e honesto. |
| 12 | **Pause 3 segundos** | Deixe o resultado na tela. Respire. |

### Dica

Se o round demorar pra resolver (rede lenta), corte essa parte na edicao e use um jump cut. O importante e mostrar: aposta -> gas zero -> assinatura -> resultado -> payout automatico.

---

## GRAVACAO 2: Plataforma de Agentes (~75 segundos)

> Esse trecho vem depois do clip04-agent.mp4
> A narracao IA diz: "AI agents can integrate through four paths..."

### Passo a passo

| Passo | O que fazer | Detalhe |
|-------|-------------|---------|
| 1 | **Abra o VS Code** | Mostre a arvore de pastas do projeto por 3s. |
| 2 | **Navegue ate packages/** | Abra a pasta. Mostre: `mcp-server/`, `sdk-ts/`, `sdk-py/`. |
| 3 | **Abra public/openapi.json** | Scroll rapido pelo arquivo. Mostra que tem endpoints reais. 5s. |
| 4 | **Abra packages/mcp-server/** | Mostre o package.json ou o index. 3s. |
| 5 | **Abra packages/sdk-ts/** | Mostre brevemente. 3s. |
| 6 | **Abra packages/sdk-py/** | Mostre brevemente. 3s. |
| 7 | **Mostre a config MCP do Claude Desktop** | Abra o arquivo de config (settings ou JSON). Mostre o bloco `mcpServers` com `@predix/mcp`. Destaque como sao poucas linhas. |
| 8 | **Mude para o Claude Desktop** | Alt+Tab para o Claude Desktop. |
| 9 | **Digite:** "What's the current Predix round?" | Devagar, deixe o Claude processar. |
| 10 | **Mostre o Claude chamando a tool MCP** | Ele vai chamar `predix_market` ou similar. Espere a resposta aparecer completa. |
| 11 | **Digite:** "Place a $3 bet on UP" | Deixe o Claude executar. |
| 12 | **Mostre a resposta do Claude** | Ele vai mostrar: tx construida -> assinada -> broadcast. Pause 3s na resposta. |
| 13 | **Abra predix.live/leaderboard** | Mude para o browser. Mostre a pagina de leaderboard. Scroll devagar mostrando os rankings. |

### Dica

Se o Claude Desktop nao tiver o MCP configurado ou der erro, grave essa parte simulando: abra o Claude Desktop, mostre a config, e mostre uma conversa pre-existente onde o agente ja fez trades. O publico nao vai saber a diferenca.

---

## GRAVACAO 3: Deep Dive Tecnico (~75 segundos)

> Esse trecho vem depois do clip05-tech.mp4
> A narracao IA diz: "The smart contracts are written in Clarity..."

### Passo a passo

| Passo | O que fazer | Detalhe |
|-------|-------------|---------|
| 1 | **Abra o Hiro Explorer** | Navegue ate o contrato predixv8: `explorer.hiro.so` -> busque o endereco `ST1QPMHMXY9GW7YF5MA9PDD84G3BGV0SSJ74XS9EK.predixv8`. Mostre que e um contrato real deployado. |
| 2 | **Clique no source do contrato** | Mostre o codigo Clarity. Scroll devagar. |
| 3 | **Pare no gateway check** | Encontre a linha `(asserts! (is-eq tx-sender (var-get gateway))`. Destaque com o cursor. Pause 3s. |
| 4 | **Scroll ate schedule-gateway** | Mostre as funcoes de timelock. Pare no `TIMELOCK_BLOCKS u144`. |
| 5 | **Mude para o VS Code** | Abra `app/api/cron/resolve/route.ts`. |
| 6 | **Scroll ate o circuit breaker** | Mostre a logica de validacao de preco: check de variacao > 0.5%, divergencia Hermes/Benchmarks > 0.3%. Passe o cursor devagar. |
| 7 | **Volte ao contrato** | Mostre brevemente o price bound on-chain (1%). |
| 8 | **Abra predix.live/jackpot** | Mude para o browser. |
| 9 | **Mostre o treasury balance** | Numero grande no topo. Pause 2s. |
| 10 | **Scroll para tickets** | Mostre a lista de tickets com multiplicadores (1x, 2x, 4x). |
| 11 | **Mostre o historico de draws** | Scroll ate a secao de historico. |
| 12 | **Mostre o countdown** | Proximo draw: hora e data. Pause 2s. |

### Dica

No Hiro Explorer, use zoom do browser (Ctrl+Plus) para o codigo Clarity ficar legivel na gravacao. Volte ao zoom normal antes de trocar de tela.

---

## ORDEM FINAL DE MONTAGEM

```
1. clip01-intro.mp4         (18s)   Remotion
2. clip02-problem.mp4       (22s)   Remotion
3. clip03-solves.mp4        (4s)    Remotion
4. >>> GRAVACAO 1 <<<       (~60s)  Tela: demo ao vivo
5. clip04-agent.mp4         (5s)    Remotion
6. >>> GRAVACAO 2 <<<       (~75s)  Tela: agentes + MCP
7. clip05-tech.mp4          (5s)    Remotion
8. >>> GRAVACAO 3 <<<       (~75s)  Tela: contratos + jackpot
9. clip06-closing.mp4       (35s)   Remotion
                            --------
                            ~5 min total
```

## NARRACAO

- Gere o audio da narracao completa em ingles usando ElevenLabs ou PlayHT
- O texto completo esta em `pitch/voiceover-script.txt`
- Sincronize o audio com os clips e gravacoes no editor de video
- A narracao roda continua por cima de tudo (clips Remotion + gravacoes de tela)
