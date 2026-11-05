/**
 * Distinguish explicit Escape cancellation from incidental keys pressed while
 * holding Option. Incidental keys preserve the locally recorded draft.
 */
export function optionRecordingKeyAction(key,{isRecording=false,trigger=null,altKey=false,timerActive=false}={}){
  if(key==="Escape" && isRecording)return "cancel";
  if(key==="Alt")return "none";
  if(trigger==="option")return "interrupt";
  return altKey||timerActive ? "block" : "none";
}
