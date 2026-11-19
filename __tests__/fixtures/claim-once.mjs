import {BridgeStore} from '../../store.mjs';
process.once('message',({db,recipient})=>{
 const store=new BridgeStore(db);
 process.send({ready:true});
 process.once('message',()=>{
  try{const claim=store.claimTask(recipient,'runner:race:'+process.pid);process.send({id:claim?.message_id??null,owner:claim?.claimed_by??null});}
  finally{store.close();process.disconnect();}
 });
});
