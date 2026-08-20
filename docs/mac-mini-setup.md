# Setup de la Mac mini (Ollama + whisper.cpp)

Runbook para dejar la Mac mini M4 de 16GB sirviendo el modelo local y el ASR
que usa `packages/llm` cuando `LLM_PROVIDER=local`. Se ejecuta a mano, una vez
por máquina; los pasos son idempotentes así que repetirlos no rompe nada.

Prod (Alibaba Cloud) usa `LLM_PROVIDER=dashscope` y no depende de esta
máquina. La mini solo sirve al proyecto corriendo en la Mac Studio, por LAN.

## 1. Instalación nativa (sin Docker)

Los contenedores no tienen acceso a Metal, así que Ollama y whisper.cpp van
nativos con Homebrew, no en el compose del proyecto:

```bash
brew install ollama whisper-cpp
```

## 2. Ollama accesible desde la LAN

Por default Ollama escucha solo en `127.0.0.1`. Hay que abrirlo a la LAN:

```bash
launchctl setenv OLLAMA_HOST 0.0.0.0
brew services restart ollama
```

Si Homebrew corre Ollama como servicio, la variable va en el plist de
`brew services` (o en `~/.zshrc` si se arranca a mano) para que sobreviva a
un reinicio.

Verificación desde la Mac Studio:

```bash
curl http://<ip-mini>:11434/api/tags
```

Debe listar los modelos instalados. Si da timeout, revisar el firewall del
punto 5 antes que nada.

## 3. Contexto explícito — el punto que no se puede saltar

Ollama trunca el prompt **en silencio** cuando pasa del contexto por
default (2048-4096 tokens según el modelo). El job de resúmenes de la Fase 4
va a mandar prompts de hasta ~12k tokens; sin este ajuste, el modelo
respondería sobre un prompt cortado y nadie lo notaría hasta revisar un
resumen incoherente.

Fijar el contexto a 16384 tokens, por variable de entorno del servicio:

```bash
launchctl setenv OLLAMA_CONTEXT_LENGTH 16384
brew services restart ollama
```

Alternativa más explícita, por modelo (Modelfile):

```
FROM qwen3:8b
PARAMETER num_ctx 16384
```

```bash
ollama create qwen3-16k -f Modelfile
```

Cualquiera de las dos sirve. Lo que no sirve es no hacer ninguna: el
benchmark del punto 6 tiene que correr ya con este valor puesto, porque un
contexto corto cambia la calidad del resumen que se está midiendo.

## 4. whisper-server como servicio

`brew install whisper-cpp` instala los binarios (`whisper-server`,
`whisper-cli`) pero **no trae ningún modelo**. `-m` espera la ruta a un
archivo `.bin` en disco, no un nombre de modelo — pasarle `large-v3-turbo` a
secas falla en el arranque (`failed to open 'large-v3-turbo'`), sin llegar a
escuchar en el puerto. Primero hay que bajar el modelo:

```bash
mkdir -p ~/ai-stack/whisper.cpp/models
curl -L -o ~/ai-stack/whisper.cpp/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

Y recién entonces arrancar el servidor con la ruta completa al `.bin`:

```bash
whisper-server --host 0.0.0.0 --port 8081 \
  -m ~/ai-stack/whisper.cpp/models/ggml-large-v3-turbo.bin --convert
```

El modelo `large-v3-turbo` (~1.5GB, acelerado por Core ML en Apple Silicon)
es el que usa `LOCAL_ASR_MODEL` por default. `--convert` le permite aceptar
el ogg/opus que manda WhatsApp sin que el cliente tenga que convertir antes
(requiere `ffmpeg` instalado en la mini).

Comando verificado contra el binario de esta máquina (ggml 0.17) con
`ggml-small.bin` como sustituto de `large-v3-turbo` — mismo `-m` con ruta
completa, mismo arranque: el servidor abre el puerto y responde 200 en `/`.
La diferencia con `large-v3-turbo` es solo el peso del archivo a descargar.

Para que sobreviva a un reinicio, un `launchd` plist en
`~/Library/LaunchAgents/com.wp.whisper-server.plist` con `KeepAlive: true`
apuntando al comando de arriba.

**Nota de contrato verificada contra el binario real** (ggml 0.17, el que
instala `brew install whisper-cpp` a la fecha de este runbook): el
`--inference-path` default de whisper-server es `/inference`, no
`/audio/transcriptions`. `packages/llm` ya lo sabe: cuando el proveedor de
ASR es `local` arma la URL con `/inference`; solo DashScope y OpenAI usan
`/audio/transcriptions`. No hace falta ninguna bandera extra para esto, es
el comportamiento normal del servidor.

## 5. IP fija y firewall

Reserva DHCP en el router para la mini (o IP estática) y usar esa IP en
`.env` del proyecto — nunca `mac-mini.local`, porque mDNS no resuelve desde
contenedores Docker.

Firewall de macOS: permitir 11434 y 8081 solo desde la subred de la LAN.
Nada de estos puertos expuesto a internet; la mini no tiene por qué ser
alcanzable desde afuera de la red de casa.

## 6. Modelos candidatos y benchmark

```bash
ollama pull qwen3:8b
```

Candidatos a evaluar (todos caben en 16GB si se cuenta el KV-cache):

| Modelo (Ollama) | Peso Q4 | Nota |
|---|---|---|
| `qwen3:8b` (arranque) | ~5.2GB | Misma familia que DashScope en prod, español sólido. Con 16k de contexto y whisper cargado queda holgura real. |
| `qwen3:14b` | ~9.3GB | Más calidad, pero con 16k de contexto y whisper cargado roza el límite de 16GB. Solo si `memory_pressure` lo aguanta. |
| `gemma3:12b-it-qat` | ~8.9GB | Alternativa fuera de la familia Qwen, por si el español de Qwen no convence en el benchmark. |

**Advertencia del KV-cache**: los pesos Q4 de la tabla son solo el modelo en
disco/RAM. Con 16k de contexto activo el KV-cache suma otros 2-3GB encima,
y whisper-server con `large-v3-turbo` cargado suma otro tanto. La cuenta que
importa es peso del modelo + KV-cache + whisper simultáneos, no el peso del
modelo solo.

Benchmark a correr con los tres candidatos, **con inputs reales del job**
de resúmenes (no frases cortas de prueba, que no representan el prompt de
~12k tokens que se manda en producción):

1. Calidad del resumen en español sobre una conversación real exportada del
   proyecto (o una sintética del mismo tamaño).
2. Latencia de transcripción ASR con un audio de duración típica de nota de
   voz de WhatsApp (10-30s).
3. `memory_pressure` con Ollama (16k de contexto cargado) y whisper-server
   corriendo al mismo tiempo — el número que decide si `qwen3:14b` es viable
   o si hay que quedarse en `qwen3:8b`.

La elección final se documenta en `LOCAL_LLM_MODEL` del `.env` de la Studio;
cambiar de modelo después es cambiar esa variable, no tocar código.

## Variables a llenar en el `.env` de la Studio

```
LOCAL_LLM_BASE_URL=http://<ip-mini>:11434/v1
LOCAL_LLM_MODEL=qwen3:8b
LOCAL_ASR_BASE_URL=http://<ip-mini>:8081
LOCAL_ASR_MODEL=large-v3-turbo
```
