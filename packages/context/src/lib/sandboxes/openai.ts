import { OpenAI } from 'openai';

export class OpenAISandbox {
  #openai = new OpenAI();
  uploadSkill() {
    // this.#openai.skills.retrieve
  }
  listSkills() {
    // TODO: Implement listing skills using this.#openai once the skills API is available.
  }
}
