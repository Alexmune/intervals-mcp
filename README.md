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

## Tools disponibles (27)

### 📊 Perfil y configuración del atleta

#### `get_athlete_profile`
Devuelve el perfil completo del atleta: nombre, ciudad, país, peso, integraciones conectadas (Garmin, Strava...), plan de intervals, configuración general.

#### `get_athlete_settings`
Lista todos los campos disponibles en el perfil del atleta vía la API.

#### `get_sport_settings`
Configuración específica de running: **Velocidad Crítica (CS)** en min/km, LTHR, FC máxima, **zonas de ritmo calculadas** (Z1-Z7) desde el CS, y **zonas de FC calculadas** desde el LTHR. No devuelve datos de ciclismo.

#### `get_performance_data`
Datos de rendimiento: CS, D' (W prime) y LTHR desde la configuración de deportes.

---

### 🏃 Actividades

#### `get_activities`
Lista de actividades recientes con distancia, ritmo, FC media, desnivel, calorías y TSS. Devuelve IDs para usar en los tools de detalle.

Parámetros: `oldest`, `newest` (YYYY-MM-DD), `limit`

#### `get_activity_detail`
Detalle completo de una actividad: métricas generales, FC media/máxima, cadencia, zonas FC (icu_zone_times), laps.

Parámetros: `activity_id`

#### `get_activity_intervals`
Datos por intervalo/lap de una sesión estructurada: distancia, duración, ritmo, FC media/máxima, cadencia, potencia por cada repetición. Imprescindible para analizar series y workouts estructurados.

Parámetros: `activity_id`

#### `get_activity_streams`
Datos segundo a segundo: FC, ritmo, cadencia, altitud, potencia. Calcula automáticamente el **tiempo en cada zona de FC** del atleta (Z1-Z5). Parámetro opcional `stream_types` para filtrar streams.

Parámetros: `activity_id`, `stream_types` (opcional)

---

### 💊 Wellness y recuperación

#### `get_wellness`
Datos de bienestar diarios: HRV, FC reposo, sueño (horas + score + calidad 1-5), pasos, VO2max, ramp rate CTL, calorías, peso, Body Battery, estrés, SpO2. Cualquier campo extra desconocido se muestra automáticamente.

Parámetros: `start_date`, `end_date` (hasta 180 días de rango)

#### `get_wellness_raw`
Volcado RAW completo de todos los campos de un día concreto. Útil para descubrir nuevos campos disponibles en la API.

Parámetros: `date` (YYYY-MM-DD, por defecto hoy)

#### `update_wellness`
Actualiza campos de wellness para un día: HRV, FC reposo, sueño, peso, fatiga, ánimo, motivación, agujetas, notas.

Parámetros: `date` (obligatorio) + cualquier combinación de campos opcionales

---

### 📈 Carga de entrenamiento

#### `get_fitness`
CTL (forma crónica), ATL (fatiga aguda), TSB (frescura = CTL-ATL), ramp rate. Incluye indicador de estado: 🟢 Fresco / 🟡 Óptimo / 🟠 Cansado / 🔴 Sobreentrenamiento. Últimos 14 días en tabla.

Parámetros: `start_date`, `end_date`

#### `get_training_load`
Historial de carga semana a semana con CTL/ATL/TSB y estado de forma. Hasta 52 semanas de histórico.

Parámetros: `weeks` (default 16, max 52)

#### `get_weekly_stats`
Totales semanales: km, sesiones, duración, TSS, calorías. Semanas de lunes a domingo.

Parámetros: `weeks` (default 8, max 12)

---

### 📅 Calendario y eventos

#### `get_events`
Eventos planificados en el calendario de intervals: nombre, tipo, descripción, carga objetivo, duración y distancia. Por defecto muestra los próximos 21 días.

Parámetros: `start_date`, `end_date`

#### `get_event_by_id`
Detalle completo de un evento específico del calendario.

Parámetros: `event_id`

#### `create_event`
Crea un entrenamiento o evento en el calendario. **Soporta formato estructurado de intervals** en la descripción. Horario automático: **19:00 entre semana, 09:00 sábados**.

Soporta todos los tipos: `Run`, `Ride`, `Swim`, `WeightTraining`, `Rest`.

Parámetros: `date`, `name`, `type`, `description`, `load`, `duration_mins`

Formato de descripción estructurada:
```
- 4km 5:00-5:20 Pace intensity=warmup
- 11km 4:20-4:25 Pace intensity=active
- 1km 5:30-6:00 Pace intensity=cooldown
```

Para series repetidas:
```
- 2km 5:00-5:15 Pace intensity=warmup

4x
- 1km 3:55-4:00 Pace intensity=active
- 90s 5:30-6:00 Pace intensity=recovery

- 2km 5:15-5:30 Pace intensity=cooldown
```

#### `update_event`
Actualiza un evento existente: nombre, descripción, fecha, duración o carga. Mismo formato estructurado que `create_event`.

Parámetros: `event_id` (obligatorio) + campos a modificar

#### `delete_event`
Elimina un evento del calendario.

Parámetros: `event_id`

---

### 📋 Otros

#### `get_records`
Récords personales del atleta. ⚠️ No disponible en plan FREE de intervals.icu.

---

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
