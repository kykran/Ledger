/* Trainer Tally adapter for claude.ai artifacts.
 * Data: the artifact's db, private per viewer under data/users/<id>/.
 * Calendar: the viewer's own Google Calendar connector (mcp).
 * Keep these paths stable — existing trainers' data lives here. */
(function(){
"use strict";
const SERVER = "Google Calendar";
const adapter = {
  name: "claude",
  calendar: null,
  _db: null, _profRef: null, _downloads: null,
  async init(){
    const cl = window.claude;
    if (!cl || !cl.use) return {status:"nostore"};
    const [db, mcp, user, downloads] = await Promise.all(["db","mcp","user","downloads"].map(n => cl.use(n).catch(() => null)));
    this._downloads = downloads;
    if (mcp) this.calendar = {
      async call(tool, input, opts){
        const cache = {staleTime:300000, gcTime:86400000}; if (opts && opts.refresh) cache.refresh = true;
        const r = await mcp.callTool(SERVER, tool, input, {cache});
        return (r && r.payload && typeof r.payload === "object") ? r.payload : {};
      }
    };
    const id = user ? await user.id().catch(() => null) : null;
    if (!db || !id) return {status:"nostore"};
    this._db = db;
    this._profRef = db.doc("data/users/" + id + "/profile");
    return {status:"ready", account:null};
  },
  watchProfile(cb, onErr){ return this._profRef.onSnapshot(s => cb(s.exists ? s.data() : null), onErr); },
  watchClients(cb, onErr){ return this._profRef.collection("clients").onSnapshot(s => cb(s.docs.map(d => ({id:d.id, ...d.data()}))), onErr); },
  setProfile(obj){ return this._profRef.set(obj); },
  setClient(id, body){ return this._profRef.collection("clients").doc(id).set(body); },
  deleteClient(id){ return this._profRef.collection("clients").doc(id).delete(); },
  deleteProfile(){ return this._profRef.delete(); },
  async saveFile({filename, data}){
    if (!this._downloads) throw {code:"unavailable"};
    return this._downloads.save({filename, data});
  }
};
window.TrainerTally.start(adapter);
})();
