# Intervals.icu MCP Server

Servidor MCP para conectar Claude con intervals.icu.

## Variables de entorno necesarias

| Variable | Descripción |
|---|---|
| `INTERVALS_API_KEY` | Tu API Key de intervals.icu |
| `INTERVALS_ATHLETE_ID` | Tu Athlete ID de intervals.icu |
| `PORT` | Puerto (Railway lo asigna automáticamente) |

## Herramientas disponibles

- `get_activities` — Actividades recientes con métricas completas
- `get_wellness` — HRV, sueño, FC en reposo, peso, fatiga, estado de ánimo
- `get_fitness` — CTL, ATL y TSB (forma, fatiga, carga crónica)
- `get_events` — Entrenamientos planificados en el calendario
- `create_event` — Crear un entrenamiento en el calendario
- `update_wellness` — Actualizar datos de bienestar del día
- `get_athlete_profile` — Perfil, zonas, FTP, FC máxima
- `delete_event` — Eliminar un entrenamiento del calendario

## Despliegue en Railway

1. Sube este repositorio a GitHub
2. Entra en railway.app y crea un nuevo proyecto desde GitHub
3. Añade las variables de entorno en la sección Variables
4. Railway desplegará automáticamente
