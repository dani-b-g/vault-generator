# vault-generator

**[English](README.md)** | **Español**

**Una Agent Skill que convierte cualquier código o documentación en un vault de Obsidian indexado, y permite que los agentes de IA recuperen solo lo que necesita cada tarea.**

[![Licencia: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node.js ≥ 22.18](https://img.shields.io/badge/node-%E2%89%A5%2022.18-339933.svg)
![Agentes: Claude Code · Codex](https://img.shields.io/badge/agents-Claude%20Code%20%C2%B7%20Codex-6f42c1.svg)
![Dependencias en ejecución: ninguna que instalar](https://img.shields.io/badge/runtime%20deps-none%20to%20install-success.svg)

`vault-generator` sigue el formato abierto [Agent Skills](https://agentskills.io/specification). Se invoca desde tu
agente de programación (`/vault-generator` en Claude Code, `$vault-generator` en Codex). Analiza los proyectos,
paquetes, documentación y configuración que tiene delante y construye un vault de [Obsidian](https://obsidian.md).
Cada nota cita sus fuentes, lleva un identificador estable y enlaza con las notas relacionadas. El vault se mantiene
sincronizado a medida que cambia el código, y los agentes (y las personas) pueden hacerle preguntas concretas en lugar
de leer todo el repositorio.

> **Estado:** versión inicial (`1.0.0`). El motor y sus 51 pruebas automáticas se ejecutan en local con Node.js.
> Consulta las [limitaciones](#limitaciones) antes de usarlo en bases de código grandes o poco habituales.

---

## Índice

- [Por qué](#por-qué)
- [Qué hace](#qué-hace)
- [Inicio rápido](#inicio-rápido)
- [Uso de la skill](#uso-de-la-skill)
- [Instalación](#instalación)
- [Ejemplo](#ejemplo)
- [Cómo funciona](#cómo-funciona)
- [Qué garantiza](#qué-garantiza)
- [Seguridad y privacidad](#seguridad-y-privacidad)
- [Fuentes soportadas](#fuentes-soportadas)
- [Referencia](#referencia)
- [Configuración](#configuración)
- [Extensión](#extensión)
- [Limitaciones](#limitaciones)
- [Hoja de ruta](#hoja-de-ruta)
- [Desarrollo](#desarrollo)
- [Contribuir](#contribuir)
- [Licencia](#licencia)

---

## Por qué

Los agentes de programación funcionan mejor con el contexto adecuado y peor con demasiado. En un repositorio real, el
conocimiento que necesita un agente está repartido entre READMEs, documentación de API generada, especificaciones
OpenAPI, manifiestos, registros de decisiones y el propio código. Pegarlo todo en el prompt es caro y ruidoso; dejarlo
fuera lleva a APIs inventadas.

`vault-generator` construye esa base de conocimiento una vez, la mantiene al día y responde con **fragmentos citados
dentro de un presupuesto de tokens**. Además, dice claramente cuando el vault no sabe algo.

## Qué hace

- **Entiende el workspace antes de tocarlo.** Distingue si tiene delante un proyecto, un monorepo, varios
  repositorios, un sitio de documentación o un vault existente. Identifica proyectos y paquetes por sus manifiestos (no
  por nombres de carpeta), construye el grafo de dependencias internas y detecta cuando estás dentro de un workspace
  mayor.
- **Genera un vault de Obsidian cuya estructura surge de las fuentes.** La organización es plana, por categorías o
  por proyecto según lo que encuentre. Las notas llevan propiedades YAML, wikilinks, etiquetas, alias, mapas de
  contenido, diagramas Mermaid y adjuntos.
- **Conserva la procedencia y la evidencia.** Cada nota indica los archivos de los que sale (con hash de contenido).
  Cada relación entre proyectos, módulos, APIs y documentos lleva la evidencia que la justifica, y las relaciones
  inferidas nunca se presentan como hechos.
- **Sincroniza de forma incremental sin pisar tu trabajo.** Solo se reprocesan las fuentes que cambian. Tus ediciones
  se conservan o se fusionan, los conflictos se guardan aparte en lugar de resolverse en silencio, y cada ejecución
  se puede deshacer.
- **Recupera de forma selectiva.** Un índice local SQLite de texto completo sobre secciones, símbolos, operaciones de
  API y relaciones alimenta `search` y los paquetes de `context` para agentes.
- **Transforma y exporta.** Convierte HTML a Markdown, OpenAPI a referencia de API, código a referencia de API y notas
  de Obsidian a CommonMark. Exporta el vault como sitio estático, un único Markdown, un paquete de contexto para un
  agente o una Agent Skill nueva.
- **Genera ejemplos fundamentados.** Los ejemplos de código y las pequeñas apps de demostración solo usan APIs
  documentadas en el vault, y nunca se dan por validados si no se han ejecutado de verdad.
- **Pregunta en lugar de suponer.** Alcance, destino, documentación contradictoria, versión por defecto, contenido
  restringido y requisitos de los ejemplos. Las respuestas se recuerdan.

## Inicio rápido

**Requisitos:** Node.js **22.18 o superior**, y [Claude Code](https://code.claude.com) o el
[Codex CLI](https://developers.openai.com/codex) (o ambos). No hay que instalar nada más: los dos pequeños parsers
que usa el motor van incluidos.

**En Claude Code**, instálala como plugin (un solo comando, sin clonar):

```text
/plugin install vault-generator --marketplace dani-b-g/vault-generator
```

**En Codex, o para incluir la skill en el commit de tu proyecto**, usa el instalador:

```sh
git clone https://github.com/dani-b-g/vault-generator.git
cd vault-generator

# instala la skill en el proyecto que quieres documentar (para Claude Code y Codex)
node skills/vault-generator/scripts/install.ts --target /ruta/a/tu/proyecto --agent both
```

Después, en el proyecto que quieres documentar:

```text
/vault-generator          ← Claude Code
$vault-generator          ← Codex
```

Sin argumentos, la skill analiza el directorio, te muestra lo que ha encontrado y la evidencia, pregunta lo que no
puede determinar, te enseña una vista previa de las notas y genera el vault (por defecto en `knowledge-vault/`) cuando
das el visto bueno.

Para tener la skill disponible en todos tus proyectos usa `--global`, que la instala en `~/.claude/skills` y
`~/.agents/skills`. [Instalación](#instalación) explica todas las opciones. La sección siguiente,
[Uso de la skill](#uso-de-la-skill), lista todas las operaciones que puedes ejecutar.

## Uso de la skill

`vault-generator` es una sola skill con un único punto de entrada. No hay sub-skills separadas que instalar ni invocar.
Lo que puedes ejecutar son sus **operaciones** (el motor las llama *modos*): dieciséis, desde `analyze` hasta `export`.
El agente elige la operación adecuada a partir de tu petición y te pregunta lo que no puede decidir por sí mismo.

### Tres formas de pedirlo

| Estilo | Ejemplo | Qué ocurre |
| --- | --- | --- |
| Sin argumentos | `/vault-generator` | Analiza el directorio (o informa de lo que ha cambiado, si ya hay un vault), pregunta lo que no puede decidir, muestra las notas y genera cuando das el visto bueno |
| Lenguaje natural, en español o inglés | `/vault-generator ¿dónde se valida el token de sesión?` | El agente traduce la petición a una operación |
| Operación explícita | `$vault-generator --mode search "retry policy" --project @acme/http` | Tus opciones se pasan al motor tal cual |

En los comandos de abajo, `vg` equivale a `node <dir-de-la-skill>/scripts/vg.mjs`, el motor que ejecuta el agente por
ti. `<dir-de-la-skill>` es `.claude/skills/vault-generator` (o `.agents/skills/vault-generator`) tras una instalación en
el proyecto. También puedes ejecutar `vg` tú mismo. [Ejecutar el motor tú mismo](#ejecutar-el-motor-tú-mismo) explica el
formato de salida y los códigos de salida.

### Operaciones

| Grupo | Operación | Para qué sirve | Escribe archivos |
| --- | --- | --- | --- |
| Construir y mantener | `analyze` | Detectar el contexto (proyecto único, monorepo, varios repositorios, sitio de documentación, vault existente) y proponer una estrategia | no |
| | `generate` | Construir el vault a partir de las fuentes seleccionadas | sí |
| | `sync` | Actualización incremental tras cambios en las fuentes | sí |
| | `status` | Qué ha cambiado desde la última ejecución: fuentes, notas editadas a mano, conflictos abiertos | no |
| Encontrar conocimiento | `search` | Recuperación selectiva, con filtros | no |
| | `context` | Paquete de contexto para una tarea concreta, dentro de un presupuesto de tokens | no (salvo `--output`) |
| Comprobar y reparar | `validate` | Comprobar estructura, metadatos, identificadores, enlaces e índice | no |
| | `reorganize` | Evaluar la estructura del vault; `--apply` mueve notas (con copias de seguridad) | solo con `--apply` |
| | `conflicts` | Listar los conflictos de sincronización y resolverlos | solo con `--resolve` |
| | `restore` | Listar las copias de seguridad y deshacer una ejecución | solo con `--run` |
| | `index` | Actualizar o reconstruir el índice de búsqueda | sí (el índice) |
| Convertir y exportar | `transform` | Convertir archivos entre formatos | sí |
| | `export` | Sitio estático, Markdown único, contexto para agentes o una Agent Skill nueva | sí |
| | `examples` | Ejemplos y apps de demostración basados en APIs documentadas | sí, fuera del vault |
| Inspeccionar la instalación | `capabilities` | Analizadores, transformadores y formatos instalados de verdad | no |
| | `validate-skill` | Comprobar un directorio de Agent Skill con la especificación | no |

Si no indicas ninguna operación, `vg` ejecuta `status` cuando encuentra un vault gestionado y `analyze` en caso
contrario. `vg sync` funciona igual que `vg --mode sync`.

### Construir y mantener

```text
/vault-generator analiza este repositorio
/vault-generator genera un vault solo para packages/core y sus dependencias
/vault-generator sincroniza el vault, he cambiado la API
/vault-generator ¿qué ha cambiado desde la última ejecución?
$vault-generator sincroniza el vault
```

```sh
vg --mode analyze                                            # solo lectura: qué hay aquí y qué se preguntaría
vg --mode generate --dry-run                                 # vista previa de las notas, no escribe nada
vg --mode generate --answer destination=default              # escribe el vault (la primera vez pregunta dónde)
vg --mode status                                             # fuentes añadidas, modificadas o eliminadas desde la última ejecución
vg --mode sync                                               # pone el vault al día
```

| Operación | Opciones | Notas |
| --- | --- | --- |
| `generate` | `--source`, `--scope`, `--vault`, `--depth`, `--language`, `--dry-run`, `--answer` | Las preguntas bloqueantes detienen la ejecución antes de escribir nada. La primera vez pregunta dónde crear el vault (por defecto `knowledge-vault/`) |
| `sync` | `--on-conflict save-both\|keep-mine\|take-source` (por defecto `save-both`), `--prune-stale`, `--trust-plugins` | Informa de recuentos, conflictos, cambios en contratos de API y cambios estructurales. Las notas cuya fuente ha desaparecido se marcan como obsoletas; `--prune-stale` las mueve a `.vault-generator/trash/` |
| `analyze`, `status` | | Solo lectura. Sin vault, `status` recurre a `analyze` |

Alcances habituales:

```sh
vg --mode generate                                           # todo el proyecto o monorepo
vg --mode generate --scope packages/core                     # parte de un monorepo (+ sus dependencias internas)
vg --mode generate --source ../frontend --source ../backend  # varios repositorios en un vault
vg --mode generate --source ./docs-site                      # solo documentación
vg --mode generate --source ../proyecto --vault ~/MiVault    # dentro de un vault de Obsidian existente
```

### Encontrar conocimiento

```text
/vault-generator ¿dónde se valida el token de sesión?
/vault-generator prepara contexto para añadir paginación al endpoint /orders
```

```sh
vg --mode search "retry policy" --project @acme/http --type document --limit 5
vg --mode search --note "api-client" --section "Public API"            # lee una sección de una nota
vg --mode context "add pagination to the /orders endpoint" --budget 3000
vg --mode context "add pagination to the /orders endpoint" --output context/orders   # escribe además orders.md y .json
```

| Operación | Opciones |
| --- | --- |
| `search` | `--project`, `--type project\|module\|api\|document\|decision\|example\|operations\|moc`, `--tech`, `--version` (`any` busca en todas las versiones), `--tag`, `--status`, `--limit` (por defecto 8). `--note <ruta o título>` con `--section <encabezado>` lee una sección |
| `context` | `--project`, `--version`, `--budget` en tokens (por defecto 6000), `--limit` de notas (por defecto 8), `--format markdown\|json`, `--output <archivo>` |

Usa `context` cuando vayas a implementar, corregir, probar o migrar algo. Devuelve fragmentos citados dentro del
presupuesto, notas relacionadas, restricciones e incertidumbres explícitas. `search` sirve para consultar un dato. Cada
resultado indica de qué nota y de qué líneas sale, sus fuentes y la confianza de la coincidencia. Cuando no hay
coincidencias, `search` termina con el código `3`: el vault no lo cubre, así que mira el código fuente.

### Comprobar y reparar

```sh
vg --mode validate                                           # los errores terminan con código 2
vg --mode validate --check-sources                           # comprueba además que cada archivo fuente citado sigue existiendo
vg --mode reorganize                                         # solo propuesta: huérfanas, carpetas enormes, nombres ambiguos
vg --mode reorganize --apply --answer reorganize-confirm=yes # aplica los movimientos (con copia de seguridad y enlaces reescritos)
vg --mode conflicts                                          # conflictos abiertos, con un diff de las dos versiones
vg --mode conflicts --resolve <conflict-id> --take mine      # o source, o merged (quitaste los marcadores a mano)
vg --mode restore                                            # lista las ejecuciones con copia de seguridad
vg --mode restore --run <runId> --dry-run                    # previsualiza deshacer una ejecución; quita --dry-run para hacerlo
vg --mode index --rebuild                                    # recrea el índice de búsqueda (sirve para cualquier vault de Obsidian)
```

Los errores de `validate` indican metadatos, identificadores, marcadores o enlaces rotos, o un secreto o una ruta
privada filtrados. Se arreglan con `sync` o `index`, no editando los bloques generados. `reorganize --apply` y `restore`
también guardan copia de seguridad, así que ambos se pueden deshacer.

### Convertir y exportar

```text
/vault-generator exporta el vault como sitio HTML
/vault-generator exporta una skill con la documentación de orders
```

`transform` convierte archivos que no están en el vault. El transformador se deduce de la entrada, salvo que indiques
uno con `--transformer`:

| Entrada | Transformador | Resultado |
| --- | --- | --- |
| Archivo `.html`, o carpeta con HTML (incluidos sitios de documentación generados) | `html-to-markdown` | Markdown sin la navegación |
| OpenAPI o Swagger `.json` / `.yaml` | `openapi-to-markdown` | Una referencia de API |
| Archivo o carpeta de código fuente | `code-to-markdown` | Una referencia de API de la superficie pública |
| Nota de Obsidian `.md` | `obsidian-to-commonmark` | CommonMark portable (wikilinks y callouts convertidos) |

```sh
vg --mode transform --input docs-site/ --output docs-md
vg --mode transform --input openapi.yaml
vg --mode transform --input note.md --transformer obsidian-to-commonmark
```

`export` convierte el propio vault en otra cosa:

| `--to` | Crea | Ubicación por defecto | Opciones adicionales |
| --- | --- | --- | --- |
| `html` | Un sitio estático con enlaces resueltos y búsqueda por título | `<vault>/.vault-generator/exports/site/` | `--project`, `--type`, `--tag` |
| `bundle` | Un único archivo Markdown portable | `<vault>/.vault-generator/exports/bundle.md` | `--project`, `--type`, `--tag` |
| `context` | Un paquete de contexto para una tarea (Markdown y JSON) | `<vault>/.vault-generator/exports/context-<tarea>.md` y `.json` | `--task "<objetivo>"`, `--budget`, `--project`, `--type`, `--version` |
| `skill` | Una Agent Skill nueva (`SKILL.md` y un archivo de referencia por nota) | `./<name>/` | `--name <nombre-de-la-skill>` (obligatorio; minúsculas, dígitos y guiones sencillos), `--project`, `--type`, `--tag` |

```sh
vg --mode export --to html
vg --mode export --to bundle --output out/vault.md
vg --mode export --to context --task "add pagination to /orders" --output out/orders-context
vg --mode export --to skill --name orders-kb --project @acme/orders
```

Cada `transform` y `export` informa de sus validaciones y de lo que se pierde en la conversión. `transform`,
`export --to bundle`, `export --to skill` y `examples` se niegan a sobrescribir una salida que ya existe salvo que pases
`--force`. `export --to html` y `export --to context` renuevan la salida que crearon antes, y `html` se niega a usar una
carpeta que no creó él. Las notas restringidas se dejan fuera salvo que pases `--include-restricted`.

`examples` escribe código que solo usa APIs documentadas en el vault:

```sh
vg --mode examples --project @acme/http --goal "retry a failed request" --kind snippet
vg --mode examples --project @acme/http --goal "paginate orders" --kind app --validate
```

| Opción | Significado |
| --- | --- |
| `--project`, `--goal`, `--kind snippet\|app` | Qué construir. Lo que falte vuelve como pregunta |
| `--output <dir>` | Dónde escribirlo (por defecto `examples/<proyecto>-<objetivo>`, fuera del vault) |
| `--validate` | Para una app Node.js, ejecuta `npm install` y la arranca. Sin ella solo se comprueba la sintaxis |
| `--force` | Sobrescribe un ejemplo existente |

Un ejemplo nunca se da por validado si sus comprobaciones no se han ejecutado y superado.

### Inspeccionar la instalación

```sh
vg --mode capabilities                                       # analizadores, transformadores, formatos, plugins, índice de búsqueda
vg --mode validate-skill --skill-dir .claude/skills/vault-generator
```

### Opciones comunes a todas las operaciones

| Opción | Significado |
| --- | --- |
| `--source <ruta>` | Directorio o archivo fuente. Se puede repetir o separar por comas. Por defecto: el directorio actual, o las fuentes guardadas en el vault |
| `--scope <proyecto>` | Limita a proyectos (id, nombre, ruta o glob). Las dependencias internas se añaden solas; `--answer scope-deps=exclude` las deja solo como resumen |
| `--vault <dir>` | Directorio del vault. Por defecto: el vault gestionado en o bajo el directorio actual; si no, `<fuente>/knowledge-vault` |
| `--answer <id>=<valor>` | Responde una pregunta de una ejecución anterior. Se puede repetir. Se guarda en el vault y no se vuelve a preguntar |
| `--depth shallow\|standard\|deep` | Cuánto detalle de código entra en las notas (25, 80 o 400 símbolos por módulo) |
| `--language en\|es` | Idioma de los encabezados y etiquetas generados (se detecta por los README si no se indica) |
| `--dry-run` | Calcula todo, no escribe nada, informa del plan |
| `--include-restricted` | Incluye las notas restringidas en búsqueda, contexto y exportación. Úsalo solo a propósito |
| `--config <archivo>`, `--cwd <dir>` | Un archivo de configuración; ejecutar como si estuvieras en otro directorio |
| `--json`, `--verbose` | Salida legible por máquinas; más detalle (y trazas de pila en los errores) |

### Preguntas que hace la skill

Cuando una decisión cambia el resultado y las fuentes no la resuelven, el motor devuelve una pregunta en lugar de
suponer. Una pregunta bloqueante detiene la ejecución antes de escribir nada (código de salida `10`). Respóndela en el
chat, o añade `--answer <id>=<valor>` y vuelve a ejecutar el mismo comando. Las preguntas opcionales no bloquean: se
mencionan en el resumen y se pueden responder en el siguiente `sync`.

| Pregunta | Cuándo | Opciones |
| --- | --- | --- |
| `destination` | El primer `generate` | `default` (la ruta propuesta) o cualquier ruta |
| `vault-placement` | El destino ya contiene notas que no creó esta herramienta | `subfolder`, `root`, `cancel` |
| `scope` | Más de 12 proyectos, o varios sin relación y sin herramienta de workspace | `all`, o ids de proyecto |
| `restricted-docs` | Hay documentos que parecen privados | `exclude`, `restricted`, `public` |
| `reorganize-confirm` | `reorganize --apply` tiene movimientos que hacer | `yes`, `no` |

Las contradicciones entre fuentes, las relaciones inferidas por patrones y la versión de documentación por defecto son
preguntas opcionales. [questions.md](skills/vault-generator/references/questions.md) (en inglés) lista todas las
preguntas y qué hace cada respuesta.

### Flujos típicos

```sh
# La primera vez
vg --mode analyze                                  # ¿qué hay aquí?
vg --mode generate --dry-run                       # ¿qué se escribiría?
vg --mode generate --answer destination=default    # escríbelo
vg --mode validate

# Tras cambiar código o documentación
vg --mode status
vg --mode sync

# Antes de trabajar en una tarea
vg --mode context "add a getProduct function to the api client" --budget 1200

# Compartirlo
vg --mode export --to html
```

### Ejecutar el motor tú mismo

`vg` acepta `--mode <operación>` (o la operación como primera palabra) y, opcionalmente, una petición en lenguaje
natural. Con `--json`, cada llamada devuelve el mismo sobre, que es lo que lee el agente:

```json
{ "ok": true, "mode": "generate", "status": "done", "summary": "...", "data": {}, "questions": [], "warnings": [], "next": [] }
```

`status` es `done`, `needs_input`, `dry_run` o `error`, y `next` sugiere el siguiente comando.

| Código de salida | Significado |
| --- | --- |
| `0` | Correcto |
| `1` | Error, por ejemplo un modo desconocido, una opción incorrecta o una salida que ya existe |
| `2` | `validate` encontró errores |
| `3` | No se encontró nada (`search`) |
| `4` | Nota o sección no encontrada (`search --note`) |
| `10` | Necesita datos: lee `questions` y responde con `--answer` |

Sin `--mode`, `vg "where is the retry policy documented?"` elige una operación por palabras clave en inglés o español
(`sincroniza` ejecuta `sync`, una pregunta ejecuta `search`) e indica cuál ha elegido en `warnings`. Los agentes eligen
la operación por sí mismos, así que usa `--mode` en scripts. La referencia completa de opciones está en
[operations.md](skills/vault-generator/references/operations.md).

## Instalación

Hay dos formas de instalarla: como **plugin de Claude Code** (un comando, solo Claude Code) o con el **instalador**,
que copia la skill en tu proyecto o en tu directorio personal, para Claude Code y Codex. Los pasos 1 a 4 de más abajo
describen el instalador; el paso 1 (los requisitos) vale para las dos.

### Instalar como plugin de Claude Code

Este repositorio es también un marketplace de plugins de Claude Code, así que Claude Code puede descargar, instalar y
actualizar la skill por sí mismo: sin clonar y sin instalador. Sigue haciendo falta Node.js 22.18 o superior.

```text
/plugin install vault-generator --marketplace dani-b-g/vault-generator
```

Claude Code te pide que confirmes el marketplace y después te deja elegir el alcance: solo tú en todos los proyectos
(`user`), todos los que trabajan en un repositorio (`project`) o solo tú en un repositorio (`local`). Desde una shell,
sin abrir una sesión (Claude Code 2.1.292 o posterior):

```sh
claude plugin install vault-generator --marketplace dani-b-g/vault-generator
```

En versiones anteriores, añade primero el marketplace y luego instala:

```text
/plugin marketplace add dani-b-g/vault-generator
/plugin install vault-generator@vault-generator
```

Compruébalo:

```sh
claude plugin list                    # vault-generator@vault-generator, Status: enabled
claude plugin details vault-generator
```

La skill responde a `/vault-generator` y a `/vault-generator:vault-generator`. Si no aparece, ejecuta
`/reload-plugins` o reinicia Claude Code, y mira la pestaña **Errors** de `/plugin`.

Diferencias con el instalador:

- **Solo Claude Code.** El plugin es para Claude Code. Para Codex, usa el instalador.
- **Lo gestiona Claude Code.** La copia vive en `~/.claude/plugins/`; no la edites. Con alcance `user` no se añade nada
  a tu proyecto. Para dar la skill a un equipo, instala con `--scope project` (cada persona del equipo ejecuta la
  instalación una vez) o usa el instalador y haz commit de `.claude/skills/`.
- **Actualizaciones.** Claude Code no actualiza solo los marketplaces de terceros salvo que lo actives (`/plugin` y
  luego **Marketplaces**). Actualiza a mano con `claude plugin update vault-generator@vault-generator`. La versión del
  plugin sigue los commits de este repositorio.
- **Desinstalar.** `claude plugin uninstall vault-generator@vault-generator`. Añade
  `claude plugin marketplace remove vault-generator` para quitar también el marketplace.

### 1. Comprueba los requisitos

```sh
node --version     # debe mostrar v22.18.0 o superior
```

| Requisito | Versión | Motivo |
| --- | --- | --- |
| Node.js | 22.18 o superior | Ejecuta directamente el motor en TypeScript y aporta el índice de búsqueda SQLite integrado |
| Claude Code y/o Codex CLI | actuales | Para invocar la skill desde un agente (`/vault-generator`, `$vault-generator`) |
| Git | cualquiera | Solo para clonar este repositorio; vale cualquier forma de descargar los archivos |
| Python 3 | opcional | Solo para comprobar la sintaxis de los ejemplos generados en Python |

No hay paso de `npm install`. Todo lo que la skill necesita para funcionar está en `skills/vault-generator/`,
incluidos los dos parsers empaquetados. No hacen falta variables de entorno ni cuentas.

### 2. Descarga la skill

```sh
git clone https://github.com/dani-b-g/vault-generator.git
cd vault-generator
```

### 3. Instálala

El instalador copia `skills/vault-generator/` en los directorios donde cada agente busca skills:

| Alcance | Comando | Ubicación en Claude Code | Ubicación en Codex |
| --- | --- | --- | --- |
| Un proyecto | `node skills/vault-generator/scripts/install.ts --target /ruta/al/proyecto` | `<proyecto>/.claude/skills/vault-generator/` | `<proyecto>/.agents/skills/vault-generator/` |
| Todos tus proyectos | `node skills/vault-generator/scripts/install.ts --global` | `~/.claude/skills/vault-generator/` | `~/.agents/skills/vault-generator/` |

Por defecto se instala para los dos agentes. Añade `--agent claude` o `--agent codex` para instalar solo uno. En
Windows, PowerShell y el Símbolo del sistema usan los mismos comandos con rutas de Windows, por ejemplo
`--target C:\trabajo\mi-proyecto`.

Salida de ejemplo:

```text
✔ claude-code: installed /ruta/al/proyecto/.claude/skills/vault-generator
✔ codex: installed /ruta/al/proyecto/.agents/skills/vault-generator

Invoke with /vault-generator in Claude Code and $vault-generator in Codex (restart the agent if the skill does not appear).
```

**¿En el proyecto o global?** Instálala en el proyecto si quieres que la tenga todo el equipo: haz commit de las
carpetas `.claude/skills/` y `.agents/skills/` junto con el proyecto. Instálala de forma global si la quieres en todos
los repositorios de tu máquina, solo para ti.

**La instalación manual** también sirve, porque la skill es una carpeta autocontenida. Copia `skills/vault-generator/`
en una de las ubicaciones anteriores, manteniendo el nombre de carpeta `vault-generator`.

### 4. Comprueba que funciona

```sh
# el motor funciona por sí solo (no hace falta el agente)
node /ruta/al/proyecto/.claude/skills/vault-generator/scripts/vg.mjs --mode capabilities

# la copia instalada es una Agent Skill válida
node /ruta/al/proyecto/.claude/skills/vault-generator/scripts/vg.mjs --mode validate-skill \
  --skill-dir /ruta/al/proyecto/.claude/skills/vault-generator
```

`capabilities` debe indicar `search index available (SQLite FTS5)`. Si no lo hace, tu Node.js es demasiado antiguo.

Después abre el proyecto en tu agente:

| Agente | Comprobación | Invocación |
| --- | --- | --- |
| Claude Code | Escribe `/` y busca `vault-generator` en la lista | `/vault-generator` |
| Codex | Ejecuta `/skills` y busca `vault-generator` | `$vault-generator` |

Claude Code detecta las skills nuevas mientras está en marcha. Si la skill no aparece, reinicia el agente; Codex
también recomienda reiniciar después de instalar una skill.

### Actualizar

Descarga la última versión y vuelve a ejecutar el mismo comando de instalación:

```sh
git pull
node skills/vault-generator/scripts/install.ts --target /ruta/al/proyecto
```

Puedes repetir la instalación sin riesgo:

- Una copia idéntica no se toca (`up-to-date`).
- Una copia instalada por una versión anterior se sustituye (`updated`).
- Una copia que editaste a mano, o una skill distinta que también se llama `vault-generator`, **no** se sustituye. El
  instalador se detiene e indica `refused`. Añade `--force` para sustituirla; antes se guarda una copia de seguridad
  en `.vault-generator-install-backups/` (en el proyecto, o en tu directorio personal con `--global`).
- `--dry-run` muestra lo que haría sin escribir nada.

Actualizar la skill nunca toca los vaults que ya has generado. Ejecuta `sync` después si quieres que los vaults
existentes aprovechen las mejoras de los analizadores.

### Desinstalar

```sh
node skills/vault-generator/scripts/install.ts --target /ruta/al/proyecto --uninstall
node skills/vault-generator/scripts/install.ts --global --uninstall
```

Solo se eliminan las copias creadas por el instalador; cualquier otra cosa requiere `--force`. Los vaults generados no
se borran: son carpetas de Markdown que te pertenecen.

### Solución de problemas

| Problema | Solución |
| --- | --- |
| `vault-generator requires Node.js >= 22.18` | Actualiza Node.js (por ejemplo con `nvm install 22` o el instalador de nodejs.org) |
| La skill no aparece en el agente | Reinicia el agente, comprueba que la carpeta se llama exactamente `vault-generator` y contiene `SKILL.md`, y que has abierto el proyecto en el que la instalaste |
| `refused: installed copy was modified locally` | Tu copia es distinta de la que se instala. Consérvala o vuelve a ejecutar con `--force` (se guarda una copia de seguridad) |
| El agente pide permiso cada vez que ejecuta el motor | Es normal la primera vez. Permite `node … vg.mjs` en los permisos de tu agente si confías en él |
| `search index UNAVAILABLE` en `capabilities` | Tu Node.js no incluye `node:sqlite` con FTS5. Usa una versión oficial de Node.js 22.18 o superior |
| La skill no aparece tras instalar el plugin | Ejecuta `/reload-plugins` o reinicia Claude Code, y revisa `claude plugin list` y la pestaña **Errors** de `/plugin` |
| La instalación del plugin en un solo paso no funciona | Requiere Claude Code 2.1.292 o posterior en una shell, o 2.1.275 o posterior dentro de una sesión. Actualiza Claude Code, o añade primero el marketplace e instala en dos pasos |

## Ejemplo

Partimos de un pequeño monorepo pnpm con una app Next.js, una API Fastify y tres paquetes compartidos. La primera
ejecución pregunta antes de escribir nada:

```text
$ vg --mode generate
? [generate] Input needed before writing anything (1 blocking question(s)).

Questions (answer to continue):
  • [destination] (blocking) Where should the vault be created? Proposed: knowledge-vault
      why: Writing a new directory is a decision only you can make. Answer "default" to accept the proposal or give a path.
```

Tras responder, genera una nota por proyecto, una nota de inicio con el grafo de dependencias, un índice de
tecnologías y una nota de *Open questions*. Esta es la nota del cliente de API compartido, sin editar:

````markdown
---
title: "@shop/api-client"
type: project
version: 0.2.0
tags: [kind/library, project/shop-api-client, tech/typescript, type/project]
belongs_to: ["[[shop]]"]
depends_on: ["[[shop-models]]"]
used_by: ["[[shop-web]]"]
symbols: [getProducts]
vg:
  id: vg-5d5aaa84ae
  origin: generated
  confidence: verified
  sources: ["shop:packages/api-client/package.json@b63a1f77c3e8"]
---
<!-- vg:begin -->
# @shop/api-client

**Kind:** library · **Ecosystem:** node · **Version:** `0.2.0` · **Path:** `packages/api-client`

## Purpose

*No description is declared in the sources.*

## Workspace dependencies

- [[shop-models]] — packages/api-client/package.json declares @shop/models (workspace:*) [prod]

## Public API

#### getProducts · function

```ts
async function getProducts(): Promise<Product[]>
```

Fetch all products from the API.

*Defined in* `packages/api-client/src/index.ts:4`

## Possible relations (unverified)

> [!question] These relations were derived from patterns (names, URLs, routes). They are not stated by any source; confirm or reject them before relying on them.

- [[shop-api-client]] **consumes** [[shop-api]] — literal "http://localhost:4000/products" matches route GET /products declared in apps/api/src/main.ts:5
<!-- vg:end -->

<!-- Add your own notes below this line. vault-generator never modifies content outside the vg:begin / vg:end block. -->
````

(El frontmatter está abreviado para el README; con `--language es` los encabezados de las notas salen en español.)
Fíjate en varias cosas:

- La descripción que falta se indica como tal, no se inventa.
- La relación `depends_on` está verificada porque la declara un manifiesto.
- La relación cliente → API solo es una coincidencia de patrón, así que aparece como *posible* y se pide al usuario
  que la confirme.
- Lo que escribas debajo de la última línea no lo toca ninguna sincronización posterior.

Un agente que va a modificar ese código pide un paquete de contexto en lugar de leer el repositorio:

```text
$ vg --mode context "add a getProduct function to the api client" --budget 1200
# Context package: add a getProduct function to the api client
> 6 fragment(s) · ~330/1200 tokens. Every fragment cites its note and original source.

## Uncertainties
- Some relations shown are inferred (unverified).

## Relevant knowledge
### @shop/api-client › Public API › getProducts · function
*Note:* `shop-api-client.md` lines 64–79 · *confidence:* high
*Sources:* `shop:packages/api-client/package.json@b63a1f77c3e8`
...
```

## Cómo funciona

```text
fuentes ─► detección de contexto ─► escaneo seguro ─► analizadores ─► modelo de conocimiento ─► planificador
                                                                                                    │
                  search / context ◄── índice SQLite FTS5 ◄── reconciliación no destructiva ◄─────────┘
```

1. **La detección de contexto** lee evidencias: archivos de workspace (npm, pnpm, Yarn, Nx, Turborepo, Lerna, Rush,
   Go workspaces, Cargo, Maven, Gradle, soluciones .NET, uv, Deno, submódulos git), manifiestos, repositorios git,
   árboles de documentación y vaults existentes. El resultado lleva una puntuación de confianza y una lista de
   ambigüedades.
2. **El escaneo** respeta `.gitignore`, omite directorios de dependencias y de compilación, nunca lee archivos de
   secretos y marca los documentos que parecen privados.
3. **Los analizadores** extraen documentos (Markdown, MDX, HTML, sitios de documentación generados, texto plano,
   Mermaid), contratos de API (OpenAPI 3 / Swagger 2), la superficie pública del código (símbolos exportados, firmas,
   comentarios de documentación, rutas HTTP, imports) y la configuración operativa (Docker, Compose, Kubernetes,
   workflows de CI, Terraform, plantillas de entorno, Makefiles).
4. **El modelo de conocimiento** une todo en proyectos, módulos, documentos, APIs, decisiones y ejemplos, enlazados
   con `belongs-to`, `depends-on`, `implements`, `exposes`, `consumes`, `documents`, `exemplifies`, `supersedes` y otras
   relaciones. Cada relación es `verified` (la declara una fuente), `inferred` (coincidencia de patrón) o `confirmed`
   (confirmada por ti). El modelo también detecta contradicciones entre fuentes, como versiones de runtime distintas o
   scripts documentados que no existen.
5. **El planificador** decide la organización del vault según lo encontrado. Agrupa los proyectos pequeños en una
   nota, divide los documentos demasiado grandes por encabezados y elimina duplicados idénticos. Las notas índice solo
   se crean cuando aportan algo.
6. **La reconciliación** escribe el plan sin destruir nada (ver abajo) y después **indexa** el vault en una base de
   datos SQLite FTS5 local.

El `SKILL.md` de la skill es corto. El agente carga los procedimientos detallados de `references/` solo cuando una
tarea los necesita, siguiendo el modelo de carga progresiva de Agent Skills.

## Qué garantiza

- **Solo evidencias.** Las notas recogen lo que muestran las fuentes y las citan. Lo desconocido se escribe como
  desconocido.
- **Tu contenido es tuyo.** El contenido generado vive entre `<!-- vg:begin -->` y `<!-- vg:end -->`. Lo que haya
  fuera de ese bloque nunca se modifica. Lo que edites dentro se fusiona con el nuevo contenido de las fuentes (fusión
  a tres bandas) o se registra como conflicto conservando las dos versiones. Las propiedades que añadas a una nota
  sobreviven a las sincronizaciones.
- **Identidad estable.** Cada nota tiene un `vg.id` estable. Renombrar o mover una nota, o renombrar un archivo
  fuente cuyo contenido no cambia, conserva su identidad y sus enlaces.
- **No se borra nada.** Las notas cuya fuente ha desaparecido se marcan como obsoletas, no se eliminan. Cada ejecución
  que cambia archivos guarda copias de seguridad y un diario, y `restore` la deshace.
- **Idempotente y reproducible.** Volver a ejecutar sin cambios no escribe nada. Las mismas fuentes y configuración
  producen las mismas notas.
- **Pregunta antes de decidir por ti.** Las preguntas bloqueantes detienen la ejecución antes de escribir nada. Las
  respuestas se guardan en el manifiesto y no se vuelven a preguntar.

## Seguridad y privacidad

Los scripts aplican estas reglas a sus propias lecturas y escrituras. Son comprobaciones en el código, cubiertas por
pruebas, no convenciones:

- Solo se escribe en directorios autorizados (el vault y las rutas de salida que indiques), nunca dentro de `.git/`
  ni `node_modules/`.
- Se rechaza el *path traversal*, y los enlaces simbólicos solo se siguen si no salen de la fuente.
- Los archivos de secretos (`.env`, claves privadas, credenciales, configuraciones cloud, estado de Terraform) nunca
  se leen. Los valores con aspecto de secreto en otros archivos (tokens, claves, contraseñas, credenciales en URLs) se
  ocultan antes de llegar a una nota, al índice o a una exportación. `validate` falla si alguno se cuela.
- Los documentos que parecen privados requieren una decisión explícita. Las notas restringidas no aparecen en
  búsquedas, contextos ni exportaciones salvo que las pidas.
- El texto de los documentos se trata como datos. El contenido que parece dar instrucciones a un agente de IA se marca
  en el vault, y la skill indica al agente que nunca lo siga.
- El manifiesto y el estado guardan solo rutas relativas, nunca rutas absolutas ni contenidos de archivos. Los plugins
  solo se ejecutan cuando confías en ellos de forma explícita.
- Todo se ejecuta en local. El motor no hace peticiones de red. Las únicas excepciones son opcionales y explícitas:
  `examples --validate` ejecuta `npm install` / `npm start` para un ejemplo generado, y un sitio HTML exportado carga
  Mermaid desde un CDN en el navegador del lector para dibujar los diagramas.

La skill no puede limitar las demás herramientas de tu agente. Configura también sus permisos (en Claude Code
`permissions.deny`, en Codex `sandbox_mode` / `approval_policy`). Consulta
[references/security.md](skills/vault-generator/references/security.md).

## Fuentes soportadas

| Tipo | Soporte |
| --- | --- |
| Documentación | Markdown, MDX (los componentes se sustituyen por marcadores), HTML, texto plano, Mermaid. reStructuredText y AsciiDoc se importan como texto |
| Documentación generada | Sitios de TypeDoc, Compodoc, Javadoc, Sphinx, MkDocs y Docusaurus (se elimina la navegación) |
| Contratos de API | OpenAPI 3.x y Swagger 2.0 en JSON o YAML, con detección de cambios de contrato |
| Código (superficie pública) | TypeScript/JavaScript (incl. JSX, Vue, Svelte, Astro), Python, Go, Java, Kotlin, Scala, C#, Rust, Swift, PHP, Dart, C/C++ |
| Ecosistemas | Node.js, Python, Go, Rust, JVM (Maven/Gradle), .NET, PHP, Ruby, Dart/Flutter, Elixir, Deno |
| Configuración | Dockerfile, Docker Compose, Kubernetes, GitHub Actions, GitLab CI, Terraform, Helm, plantillas de entorno, Makefile/justfile, archivos de versión de runtime |
| Vaults | Vaults de Obsidian existentes, tengan o no notas creadas por esta herramienta |

Ejecuta `vg --mode capabilities` para ver exactamente qué soporta tu instalación, incluido lo que no está implementado.

## Referencia

La documentación detallada vive junto a la skill y es lo que lee el agente (está en inglés):

| Documento | Contenido |
| --- | --- |
| [SKILL.md](skills/vault-generator/SKILL.md) | Las instrucciones que sigue el agente: activación, elección de operación, preguntas, seguridad |
| [operations.md](skills/vault-generator/references/operations.md) | Todos los modos y opciones de la CLI, códigos de salida, claves de configuración |
| [questions.md](skills/vault-generator/references/questions.md) | Todas las preguntas que puede hacer la skill, cuándo y qué hace cada respuesta |
| [vault-format.md](skills/vault-generator/references/vault-format.md) | Anatomía de las notas, identificadores, enlaces, reglas de organización, el directorio `.vault-generator/` |
| [sync-and-conflicts.md](skills/vault-generator/references/sync-and-conflicts.md) | Detección de cambios, reglas de fusión, resolución de conflictos, recuperación |
| [retrieval.md](skills/vault-generator/references/retrieval.md) | El índice, la ordenación de búsquedas y los paquetes de contexto |
| [security.md](skills/vault-generator/references/security.md) | Controles aplicados y lo que debes configurar en tu agente |
| [examples.md](skills/vault-generator/references/examples.md) | Cómo se producen y validan los ejemplos y apps de demostración |
| [extending.md](skills/vault-generator/references/extending.md) | Cómo escribir plugins de analizadores y transformadores |

## Configuración

La configuración es opcional. Añade `vault-generator.config.json` en la raíz de un proyecto para fijar valores por
defecto:

```json
{
  "sources": ["."],
  "vault": "knowledge-vault",
  "language": "es",
  "depth": "standard",
  "exclude": ["**/fixtures/**", "legacy/**"],
  "access": { "deny": ["secrets/**"], "restricted": ["docs/internal/**"] },
  "plugins": []
}
```

Las claves principales fijan las fuentes, el vault y el alcance por defecto; el idioma de las notas (`es` o `en`; si
no se indica, se detecta); el nivel de detalle del código (`shallow`, `standard` o `deep`); las reglas de inclusión y
exclusión, y las reglas de acceso. Hay un ejemplo completo con todas las claves en
[assets/vault-generator.config.example.json](skills/vault-generator/assets/vault-generator.config.example.json), y cada
clave se describe en [operations.md](skills/vault-generator/references/operations.md#configuration-file). No se usan
variables de entorno.

## Extensión

Los formatos y tipos de salida nuevos se añaden como plugins locales, sin tocar el núcleo:

```js
// vault-plugins/asciidoc.mjs — se declara en "plugins" en la configuración
export default {
  analyzers: [{
    id: 'asciidoc', version: '1', description: 'AsciiDoc documents', handles: ['.adoc'],
    limitations: ['Tables and includes are not converted'],
    match: (file) => (file.ext === '.adoc' ? 30 : 0),
    analyze(file, ctx) { /* devuelve documentos, entidades, relaciones y hechos */ },
  }],
  transformers: [],
};
```

Cada analizador y transformador declara qué maneja y qué no puede conservar, y `capabilities` informa de ambas cosas.
Los plugins solo se cargan después de que los revises y ejecutes una vez con `--trust-plugins`. Su hash de contenido
queda fijado, así que un plugin modificado hay que volver a aprobarlo. El contrato completo está en
[extending.md](skills/vault-generator/references/extending.md).

## Limitaciones

- **Los archivos PDF, Word y PowerPoint no se convierten.** Aparecen como no soportados en el vault, nunca se
  descartan en silencio.
- **La recuperación es léxica** (ordenación BM25, coincidencia de símbolos y operaciones, expansión por relaciones).
  No hay embeddings ni búsqueda semántica.
- **El análisis de código es heurístico, no un compilador.** Los genéricos complejos, macros, sobrecargas y cadenas
  de reexportación pueden resumirse u omitirse. Nunca se infiere el comportamiento en tiempo de ejecución.
- **Las relaciones entre aplicaciones** que no comparten un contrato declarado solo se detectan por patrones (por
  ejemplo, una URL de un proyecto que coincide con una ruta de otro). Se quedan como "posibles" hasta que las confirmas.
- **Los `$ref` externos de OpenAPI y las fuentes remotas** no se descargan.
- **El andamiaje de ejemplos** solo soporta proyectos Node.js y Python.
- **Probado** con Node.js 24 en Windows mediante la batería automática. La invocación de extremo a extremo desde
  dentro de Claude Code y Codex todavía no está cubierta por pruebas automáticas.

## Hoja de ruta

- Extractores opcionales de PDF y DOCX como plugins con dependencias declaradas.
- Embeddings locales opcionales para búsqueda híbrida.
- Analizadores basados en compilador (API del compilador de TypeScript, Roslyn, `go/ast`) como plugins.
- Relaciones entre servicios a partir de clientes generados, colas de mensajes y esquemas de eventos.
- Andamiaje de ejemplos para Go, JVM y .NET.
- Sincronización por lotes para vaults muy grandes.

## Desarrollo

```text
skills/vault-generator/        la skill (es lo que se instala)
├── SKILL.md                   instrucciones para el agente
├── agents/openai.yaml         metadatos de interfaz para Codex
├── references/                documentación que se carga bajo demanda
├── assets/                    configuración de ejemplo
└── scripts/
    ├── vg.mjs                 punto de entrada de la CLI
    ├── install.ts             instalador
    ├── vendor/                parsers incluidos (yaml, smol-toml) y sus licencias
    └── lib/                   el motor (detección, analizadores, modelo, planificador, reconciliación, índice, …)
tests/                         pruebas unitarias y escenarios (fixtures temporales aislados)
tools/build-vendor.mjs         regenera los parsers incluidos
tools/version.mjs              mantiene la versión sincronizada entre archivos y la comprueba
.claude-plugin/marketplace.json  marketplace de plugins de Claude Code (apunta a skills/vault-generator)
.github/workflows/             CI (ci.yml) y publicación de versiones (release.yml)
```

`.claude/skills/vault-generator/` y `.agents/skills/vault-generator/` son copias instaladas para poder probar la skill
en este mismo repositorio. Vuelve a ejecutar el instalador después de cambiar `skills/vault-generator/`.

```sh
npm install              # solo herramientas de desarrollo (TypeScript, esbuild, fuentes de los parsers)
npm test                 # 51 pruebas: unitarias y 28 escenarios de extremo a extremo
npm run typecheck
npm run validate-skill   # comprueba SKILL.md con la especificación de Agent Skills
claude plugin validate . --strict  # comprueba el marketplace del plugin (requiere Claude Code)
npm run version:check    # la versión es la misma en todos los archivos y las copias instaladas coinciden con la skill
npm run vendor           # regenera los parsers incluidos tras actualizarlos
```

El motor es TypeScript que Node ejecuta directamente (*type stripping*). No hay paso de compilación ni `node_modules`
en tiempo de ejecución.

### Publicar versiones

El CI (`.github/workflows/ci.yml`) se ejecuta en cada push a `master` y en cada pull request. Ejecuta la comprobación de
tipos, la batería de pruebas y `validate-skill` en Ubuntu y Windows con Node.js 22.18 y 24. También ejecuta
`claude plugin validate . --strict` y comprueba que la versión es la misma en todos los archivos y que las copias
instaladas coinciden con la skill.

Para publicar una versión, abre la pestaña **Actions** de GitHub, elige **Release** en la lista de la izquierda y pulsa
**Run workflow**. Después elige:

- **Use workflow from**: la rama desde la que publicar. Viene seleccionada la rama por defecto.
- **bump**: `patch`, `minor` o `major`.
- **beta**: márcala para publicar una beta (una pre-release) en lugar de una versión estable.

Partiendo de la versión `0.1.0`: `patch` da `0.1.1`, `minor` da `0.2.0` y `major` da `1.0.0`. Con **beta** marcada,
`minor` da `0.2.0-beta.1`, y si lo ejecutas otra vez da `0.2.0-beta.2`. Ejecutar `minor` sin **beta** a continuación
publica `0.2.0`.

El workflow reescribe todos los archivos que llevan la versión (`npm run version:set`), ejecuta la comprobación de tipos,
las pruebas y `validate-skill` sobre el resultado, y solo entonces hace commit del cambio y del tag `vX.Y.Z` en la rama
elegida con un único push atómico. Después crea una release de GitHub con notas generadas y dos archivos adjuntos:
`vault-generator-skill-vX.Y.Z.zip` (la carpeta de la skill, lista para descomprimir en `.claude/skills` o
`.agents/skills`) y `SHA256SUMS`. Si falla alguna comprobación, no se sube nada.

El workflow hay que lanzarlo desde la pestaña Actions: la página Releases solo lista las versiones. Sube a la rama
elegida, así que falla si esa rama exige pull requests.

El marketplace del plugin no tiene campo `version`, así que `claude plugin install` instala siempre el último commit de
la rama por defecto. Para fijar una versión hay que usar el zip.

## Contribuir

Se aceptan issues y pull requests. Antes de abrir un pull request:

1. Mantén la salida determinista (orden estable, sin marcas de tiempo en las notas). La reproducibilidad es una
   garantía que se prueba.
2. Añade o actualiza un fixture y una prueba para el comportamiento que cambies (`tests/fixtures.ts`,
   `tests/scenarios/`).
3. Ejecuta `npm test`, `npm run typecheck` y `npm run validate-skill`.
4. Si añades un analizador o un transformador, declara sus limitaciones con honestidad. No registres capacidades que
   no estén implementadas.
5. No subas nunca credenciales reales. Los fixtures de prueba construyen sus secretos falsos en tiempo de ejecución
   para que los escáneres de secretos no marquen el repositorio.

Las contribuciones se aceptan bajo la Apache License 2.0 (sección 5 de la licencia).

## Licencia

Distribuido bajo la [Apache License, Version 2.0](LICENSE). Las atribuciones están en [NOTICE](NOTICE).

La skill incluye [yaml](https://github.com/eemeli/yaml) (ISC) y [smol-toml](https://github.com/squirrelchat/smol-toml)
(BSD-3-Clause) en `skills/vault-generator/scripts/vendor/`, con sus textos de licencia. La skill instalada lleva sus
propios `LICENSE.txt` y `NOTICE.txt`.

Obsidian es una marca de Dynalist Inc. Claude Code es un producto de Anthropic y Codex un producto de OpenAI.
`vault-generator` es un proyecto independiente, sin afiliación ni respaldo de ninguno de ellos.
