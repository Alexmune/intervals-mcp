# intervals-mcp

Servidor MCP (Model Context Protocol) para conectar Claude con la API de [Intervals.icu](https://intervals.icu). Desplegado en Railway con transporte Streamable HTTP, permite a Claude leer y escribir datos de entrenamiento, wellness, calendario y configuración del atleta en tiempo real.

---

## Infraestructura

- **Plataforma:** Railway
- **URL:** `https://intervals-mcp-production-2be3.up.railway.app/sse`
- **Protocolo:** Streamable HTTP (POST /sse) — requerido por Claude.ai
- **Runtime:** Node.js 18, Express
- **Variables de entorno:** `INTERVALS_API_KEY`, `INTERVALS_ATHLETE_ID`, `MCP_AUTH_TOKEN` (recomendada), `TIMEZONE` (opcional)

---

## Configuración en Claude.ai

En Claude.ai → Settings → Connectors → Add MCP Server:

```
URL (con token):  https://intervals-mcp-production-2be3.up.railway.app/mcp/<MCP_AUTH_TOKEN>
URL (sin token):  https://intervals-mcp-production-2be3.up.railway.app/sse
```

Si `MCP_AUTH_TOKEN` está definido, `/sse` sin token devuelve 401. También se acepta `/sse?token=<TOKEN>` o la cabecera `Authorization: Bearer <TOKEN>`.

---

## Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `INTERVALS_API_KEY` | API key de intervals.icu (Settings → Developer) |
| `INTERVALS_ATHLETE_ID` | ID del atleta (e.g. `i553313`) |
| `PORT` | Puerto (Railway lo asigna automáticamente) |
| `MCP_AUTH_TOKEN` | Secreto largo (32+ caracteres, solo letras y números) que protege el endpoint. Sin él, cualquiera con la URL puede leer y escribir en el calendario |
| `TIMEZONE` | Zona horaria del atleta (default `Europe/Madrid`) |

---

## Novedades v7.1.0
- Cumplimiento por repetición: alineación secuencial paso a paso por duración/distancia; tolera vueltas extra y fragmentos de Garmin (modo "exacto" en fartleks reales).
- Intervalos de menos de 10 s descartados en todos los análisis.
- Tramos a ritmo maratón que terminan al final de la actividad: el índice final se acota al stream (vuelven desacoplamiento y desnivel).
- Splits: un último km parcial de menos de 100 m se suma al anterior.

## Novedades v7.0.0
- **Ahorro de cuota**: 18 herramientas (antes 29) y análisis completos en una sola llamada.
- `get_post_workout_report`: análisis post-entreno completo (métricas, GAP, plan vs hecho, zonas, cumplimiento repetición a repetición contra los ritmos del entreno planificado, bloque a ritmo maratón con FC@4:16 y desacoplamiento, splits compactos, RPE/sensaciones).
- `get_weekly_review`: revisión dominical en una llamada (plan vs hecho día a día, volumen vs 4 semanas, HRV/sueño/FC reposo vs baseline, CTL/ATL/TSB, sesiones clave, RPE pendientes, semana siguiente, cuenta atrás y tendencia de ritmo maratón).
- Semáforo 🟢🟠🔴 dentro de `get_daily_briefing`, con acción concreta según la sesión del día.
- Caché en memoria: streams (24 h), intervalos (6 h) y tramos a ritmo maratón por actividad (7 días). `get_mp_trend` solo procesa las carreras nuevas; menos errores 429. `/health` muestra el estado de la caché.
- Fusiones: `get_athlete` (perfil + ajustes + zonas + material), `get_activities` (+ `by_week`), `get_activity_data` (splits / intervalos / desacoplamiento / zonas), `get_wellness` (+ `raw_date`), `get_fitness` (+ `weeks`), `get_events` (+ `event_id`), `create_events` (una o varias, con `category` para carreras).
- Eliminadas: `get_records` (no disponible en el plan gratuito) y las herramientas sustituidas por las anteriores.
- Nuevas variables opcionales: `RACE_DATE` (default 2026-12-06), `STREAM_CACHE_MAX` (default 50), `INTERVALS_BASE_URL` (pruebas).

## Novedades v6.5.0

- `get_daily_briefing` y `get_wellness`: muestran el VO2max que Garmin sincroniza en wellness, con su evolución en 30 días

## Novedades v6.4.0

- Todas las llamadas a intervals: máximo 3 peticiones simultáneas y reintentos automáticos con espera progresiva ante 429 (límite de peticiones) y errores 5xx. Antes, un 429 hacía que actividades desaparecieran en silencio de `get_mp_trend` y `get_best_efforts`
- Los errores de intervals se registran en los logs de Railway (`⏳` reintento, `⚠️` fallo)
- `get_mp_trend` avisa si alguna actividad no se pudo leer

## Novedades v6.3.0

- `get_mp_trend`: fuente principal = intervalos de intervals (pasos del entreno estructurado o vueltas), uniendo los consecutivos dentro de la banda (sirve también con autolap de 1 km). Distancia y ritmo exactos del intervalo; GAP, FC sin retardo inicial y desacoplamiento desde los streams. La detección por GPS queda como respaldo para carreras sin vueltas (marcada con *)

## Novedades v6.2.0

- `project_fitness`: calibración automática de la carga planificada. intervals calcula la carga de los entrenos planificados con un modelo por ritmo que puede diferir mucho de la real (por FC); ahora se escala con el factor real/planificado de las últimas 8 semanas. Muestra también la conversión real TSS/km

## Novedades v6.1.0

- `get_mp_trend`: detección por ritmo ajustado a pendiente (GAP aproximado), media móvil de 60 s, banda por defecto 4:05-4:25/km y tolerancia de 45 s fuera de banda → los tramos con cuestas ya no se cortan. Desacoplamiento calculado también con GAP. La tendencia solo se calcula con ≥3 sesiones en ≥21 días

## Novedades v6.0.0

**Herramientas nuevas (2) → 29 en total:**

| Tool | Qué hace |
|---|---|
| `get_mp_trend` | Indicador de preparación para el ritmo maratón: localiza todos los tramos continuos dentro de una banda de ritmo (por defecto 4:10-4:22/km) y da, por tramo, ritmo, FC, FC normalizada al ritmo objetivo, desacoplamiento, desnivel y km de inicio (fatiga). Calcula la tendencia del coste cardíaco del ritmo maratón |
| `project_fitness` | Proyecta CTL/ATL/TSB día a día hasta una fecha usando cargas reales, entrenos planificados (con carga estimada por duración si no la traen) y cargas semanales supuestas. Incluye las 8 últimas semanas reales para calibrar y la forma la mañana de las fechas clave |

## Novedades v5.2.0

- Selección de la configuración de running: prioridad al tipo exacto `Run`. Antes podía coger la configuración "Otro" (Walk/Hike), con zonas por defecto distintas, y mostrar etiquetas de zona erróneas — y `update_sport_settings` habría escrito en la configuración equivocada
- Sesiones caducadas tras un redespliegue → HTTP 404 según la especificación MCP, para que el cliente reconecte solo en lugar de fallar

## Novedades v5.1.0 (tras pruebas con la API real)

- `create_events_bulk`: intervals devuelve los eventos ordenados por fecha → ahora se emparejan por fecha + nombre (antes la corrección de duración de fuerza podía caer en otro evento)
- Zonas FC: soporte para cualquier número de zonas (intervals usa 7: Z1-Z4, Z5a, Z5b, Z5c)
- `get_sport_settings`: muestra las zonas FC reales configuradas en intervals además de las teóricas
- `update_sport_settings`: nuevo parámetro `hr_zones` para fijar zonas explícitas
- `get_daily_briefing`: busca la última actividad hasta 14 días atrás y avisa si hace ≥3 días (posible fallo de sincronización)

## Novedades v5.0.0

**Herramientas nuevas (7):**

| Tool | Qué hace |
|---|---|
| `get_daily_briefing` | Informe matutino en 1 llamada: HRV vs baseline 30d (media ± SD), FC reposo, sueño (Xh XXmin), CTL/ATL/TSB, entrenos de hoy y mañana, última actividad, km de la semana y alertas automáticas |
| `get_decoupling` | Desacoplamiento Pa:HR de una actividad o de un tramo (`from_km`/`to_km`), p.ej. el bloque a ritmo maratón de una tirada |
| `update_activity` | Escribe RPE (1-10), feel (1-5), nombre, descripción o añade una nota de diario a una actividad |
| `update_sport_settings` | Actualiza LTHR, FC máx, ritmo umbral/CS (m:ss) y D'. Reescala las zonas FC |
| `create_events_bulk` | Crea la semana completa en una sola llamada. Fija automáticamente la duración de las sesiones de fuerza |
| `get_gear` | Kilometraje de zapatillas/material |
| `get_best_efforts` | Mejores esfuerzos (1k-30k) desde los streams + predicción de maratón (Riegel) |

**Mejoras y correcciones:**
- `get_activity_detail`: funciona con actividades de cualquier fecha (antes solo 60 días); añade GAP, carga, intensidad, TRIMP, desacoplamiento (de intervals o calculado desde streams), Efficiency Factor, RPE/feel y material
- Zonas de FC leídas de intervals en vez de fijas en el código → si cambia el LTHR, todos los análisis se actualizan
- `get_activity_streams`: nuevo parámetro `compact` (una línea por km) para ahorrar contexto
- `get_wellness`: sueño en formato Xh XXmin
- `get_performance_data`: corregida la conversión de la CS (m/s → min/km)
- `create_event`: corrige automáticamente la duración de las sesiones de fuerza
- Fechas calculadas en hora de Madrid (antes UTC: entre las 00:00 y 02:00 "hoy" era ayer)
- Autenticación opcional por token

---

## Tools disponibles (18)

| Uso | Herramienta |
|---|---|
| Informe matutino + semáforo | `get_daily_briefing` |
| Post-entreno | `get_post_workout_report` · `update_activity` |
| Revisión dominical | `get_weekly_review` · `get_mp_trend` · `project_fitness` |
| Planificación | `create_events` · `update_event` · `delete_event` · `get_events` |
| Datos | `get_athlete` · `get_activities` · `get_activity_data` · `get_wellness` · `get_fitness` · `update_wellness` |
| Controles y umbrales | `get_best_efforts` · `update_sport_settings` |

## Formato de workout estructurado

Intervals.icu interpreta la descripción del evento si sigue este formato:

```
- [distancia o tiempo] [ritmo] Pace intensity=[tipo]
```

**Distancia/tiempo:** `4km`, `800m`, `90s`, `15m`

**Ritmo:** `4:20-4:25 Pace` (rango). Todos los pasos deben usar el mismo tipo.

**Intensidades disponibles:**

| Valor | Uso |
|---|---|
| `warmup` | Calentamiento |
| `active` | Bloque principal / carrera |
| `recovery` | Recuperación entre series |
| `cooldown` | Enfriamiento |

**Series repetidas:** añadir línea `Nx` antes del bloque (ej: `4x`, `8x`)

---

## Notas técnicas

- TSB se calcula como `CTL - ATL` cuando la API no lo devuelve directamente
- Zonas de ritmo calculadas matemáticamente desde el CS (threshold_pace en m/s)
- Zonas de FC calculadas desde el LTHR usando porcentajes estándar de intervals.icu
- VO2max leído del campo `vo2max` del endpoint de wellness (sincronizado desde Garmin)
- Body Battery y estrés no disponibles en sincronización Garmin → intervals.icu (plan FREE)
- Récords personales no disponibles en plan FREE
- Curvas de rendimiento (MMP/pace curve) no expuestas en la API pública

---

## Endpoints de la API utilizados

| Endpoint | Método | Uso |
|---|---|---|
| `/athlete/{id}` | GET | Perfil del atleta |
| `/athlete/{id}/sport-settings` | GET | Configuración por deporte |
| `/athlete/{id}/activities` | GET | Lista de actividades |
| `/activity/{id}` | GET | Detalle de actividad |
| `/activity/{id}/intervals` | GET | Intervalos de actividad |
| `/activity/{id}/streams` | GET | Streams segundo a segundo |
| `/athlete/{id}/wellness` | GET/PUT | Wellness diario |
| `/athlete/{id}/events` | GET/POST | Calendario |
| `/athlete/{id}/events/{id}` | GET/PUT/DELETE | Evento específico |
