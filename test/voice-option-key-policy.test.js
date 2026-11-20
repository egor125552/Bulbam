import{test,expect}from"vitest";
import{optionRecordingKeyAction}from"../web/js/voice-option-key-policy.js";
test("Option recording preserves a recoverable draft on accidental keys",()=>{
 expect(optionRecordingKeyAction("x",{isRecording:true,trigger:"option",altKey:true})).toBe("interrupt");
 expect(optionRecordingKeyAction("ArrowLeft",{isRecording:true,trigger:"option"})).toBe("interrupt");
 expect(optionRecordingKeyAction("Escape",{isRecording:true,trigger:"option"})).toBe("cancel");
 expect(optionRecordingKeyAction("Alt",{isRecording:true,trigger:"option"})).toBe("none");
 expect(optionRecordingKeyAction("x",{altKey:true})).toBe("block");
 expect(optionRecordingKeyAction("x",{})).toBe("none");
});
