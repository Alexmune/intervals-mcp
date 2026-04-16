# intervals-mcp

Servidor MCP (Model Context Protocol) para conectar Claude con la API de [Intervals.icu](https://intervals.icu). Desplegado en Railway con transporte Streamable HTTP, permite a Claude leer y escribir datos de entrenamiento, wellness, calendario y configuración del atleta en tiempo real.

---

## Infraestructura

- **Plataforma:** Railway
- **URL:** `https://intervals-mcp-production-2be3.up.railway.app/sse`
- **Protocolo:** Streamable HTTP (POST /sse) — requerido por Claude.ai
- **Runtime:** Node.js 18, Express
- **Variables de entorno:** `INTERVALS_API_KEY`, `INTERVALS_ATHLETE_ID`

---

## Configuración en Claude.ai

En Claude.ai → Settings → Connectors → Add MCP Server:

```
URL: https://intervals-mcp-production-2be3.up.railway.app/sse
```

---

## Variables de entorno requeridas

| Variable | Descripción |
|---|---|
| `INTERVALS_API_KEY` | API key de intervals.icu (Settings → Developer) |
| `INTERVALS_ATHLETE_ID` | ID del atleta (e.g. `i553313`) |
| `PORT` | Puerto (Railway lo asigna automáticamente) |

---

## Tools disponibles (21)

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
