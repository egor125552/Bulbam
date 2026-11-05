// Only the exit control is keyboard/VoiceOver-reachable while pocket mode runs.
export function createCallPocketMode(panel,button,announce){
 let enabled=false;
 return {
  enter(){if(enabled || !panel || !button)return;enabled=true;panel.classList.add("is-pocket");
    button.hidden=false;button.textContent="Выйти из режима в кармане";
    button.focus();announce("Режим в кармане включён. Экран защищён от случайных касаний. Для выхода нажмите Выйти из режима в кармане.");},
  exit(){if(!enabled)return;enabled=false;panel?.classList?.remove("is-pocket");
    button.textContent="Режим в кармане";announce("Режим в кармане выключен.");button.focus();},
  reset(){enabled=false;panel?.classList?.remove("is-pocket");
    if(button){button.hidden=true;button.textContent="Режим в кармане";}},
  get enabled(){return enabled;}
 };
}
