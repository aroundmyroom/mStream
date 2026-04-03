const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('save/db/mstream.sqlite');
for (const t of ['files','user_metadata','user_settings','playlists','scan_errors','smart_playlists']) {
  const info = db.prepare(`PRAGMA table_info(${t})`).all();
  console.log('\n=== '+t+' ===');
  info.forEach(c=>console.log(`  ${c.name} ${c.type} ${c.notnull?'NOT NULL':''} ${c.dflt_value!=null?'DEFAULT '+c.dflt_value:''}`));
}
