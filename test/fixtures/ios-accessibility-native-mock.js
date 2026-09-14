const state = {
  room: null,
  events: [],
  draft: "",
  command: null,
};

const success = (call, value) => ({ callId: call.callId, ok: true, value });
const rows = (column, values) => ({ columns: [column], rows: values.map((value) => [JSON.stringify(value)]) });

const database = {
  async open(call) { return success(call, { schema: 8 }); },
  async providerDataUseConsent(call) { return success(call, { consent: null }); },
  async saveProviderSelectionAndConsent(call) {
    return success(call, { consent: {
      providerId: call.payload.providerId,
      providerDefinitionVersion: call.payload.providerDefinitionVersion,
      model: call.payload.model,
      disclosureVersion: call.payload.disclosureVersion,
      acceptedAt: "2026-09-14 12:00:00",
    } });
  },
  async executeBatch(call) {
    for (const statement of call.payload.statements) {
      const parameters = statement.parameters;
      if (statement.sqlId === "create_room") {
        state.room = { id: parameters[0], title: parameters[1], status: "active", generation: 0, participants: [] };
        state.events = [];
      } else if (statement.sqlId === "create_human") {
        state.room.participants.push({ id: parameters[0], kind: "human", displayName: parameters[2], muted: false, sortOrder: 0, personaSlug: null });
      } else if (statement.sqlId === "create_persona") {
        state.room.participants.push({ id: parameters[0], kind: "persona", displayName: parameters[2], muted: false, sortOrder: parameters[3], personaSlug: parameters[4] });
      } else if (statement.sqlId === "save_draft") {
        state.draft = parameters[1];
      } else if (statement.sqlId === "delete_draft") {
        state.draft = "";
      }
    }
    return success(call, { changes: call.payload.statements.length });
  },
  async query(call) {
    const sqlId = call.payload.sqlId;
    if (sqlId === "current_room" || sqlId === "room_by_id") return success(call, rows("room_json", state.room ? [state.room] : []));
    if (sqlId === "room_events") return success(call, rows("event_record_json", state.events));
    if (sqlId === "room_list") return success(call, rows("room_summary_json", state.room ? [{ id: state.room.id, title: state.room.title, lastActivityOrder: state.events.length }] : []));
    if (sqlId === "local_draft") return success(call, rows("local_draft_json", state.draft ? [{ roomId: state.room.id, text: state.draft }] : []));
    if (sqlId === "unresolved_generation_command") return success(call, rows("generation_command_json", state.command ? [state.command] : []));
    if (sqlId === "provider_selection") return success(call, rows("provider_selection_json", []));
    if (sqlId === "provider_profile") return success(call, rows("provider_profile_json", []));
    return success(call, { columns: [], rows: [] });
  },
};

const lifecycle = {
  async status(call) {
    return success(call, { active: true, databaseReady: true, epoch: 1, pathAvailable: true, protectedDataAvailable: true });
  },
};

globalThis.Capacitor = { Plugins: { GreenRoomDatabase: database, GreenRoomLifecycle: lifecycle, GreenRoomCredential: {}, GreenRoomProvider: {} } };
globalThis.__greenroomAccessibilityFixture = state;
