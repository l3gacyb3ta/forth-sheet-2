import type { CellData } from './Spreadsheet';
import { cellKey, parseCellAddress } from './Spreadsheet';

type Code = string & { readonly __brand: unique symbol }

type Value =
    | { type: "string"; data: string }
    | { type: "number"; data: number }
    | { type: "code"; data: Code }

type WordDefinition =
    | { type: "user_defined"; code: Code }
    | { type: "native"; word: (s: Stack) => Stack }

type Stack = Array<Value>;
type WordDefinitions = Record<string, WordDefinition>;
export type Runtime = {
    stack: Stack;
    word_definitions: WordDefinitions;
    push: (value: Value) => void;
    pop: () => Value;
}

export function newRuntime(): Runtime {
    let wds: WordDefinitions = {}
    const add_word = (wds: WordDefinitions, k: string, w: (s: Stack) => Stack) => {
        wds[k] = { type: "native", word: w }
    };

    const s_pop = (s: Stack): Value => {
        if (s.length === 0) {
            throw new Error("Stack underflow");
        }
        let v = s.pop();
        return v ?? { type: "number", data: 0 };
    };

    add_word(wds, "dup", (s) => { let v = s_pop(s); s.push(v); s.push(v); return s; });
    add_word(wds, "over", (s) => { let v = s_pop(s); let w = s_pop(s); s.push(w); s.push(v); s.push(w); return s; });
    add_word(wds, "swap", (s) => { let v = s_pop(s); let w = s_pop(s); s.push(v); s.push(w); return s; });

    add_word(wds, "str", (s) => { let v = s_pop(s); if (v.type === "string") { s.push(v); } else { s.push({ type: "string", data: String(v.data) }); } return s; });


    const pop_2_num = (s: Stack): [number, number] => {
        let v = s_pop(s);
        let w = s_pop(s);
        if (v.type !== "number" || w.type !== "number") {
            throw new Error("Expected two numbers on stack");
        }
        return [v.data, w.data];
    };

    add_word(wds, "+", (s) => {
        let [v, w] = pop_2_num(s);
        s.push({ type: "number", data: v + w });
        return s;
    });
    add_word(wds, "-", (s) => {
        let [v, w] = pop_2_num(s);
        s.push({ type: "number", data: v - w });
        return s;
    });
    add_word(wds, "/", (s) => {
        let [v, w] = pop_2_num(s);
        s.push({ type: "number", data: v / w });
        return s;
    });
    add_word(wds, "*", (s) => {
        let [v, w] = pop_2_num(s);
        s.push({ type: "number", data: v * w });
        return s;
    });

    return {
        stack: [],
        word_definitions: wds,
        push(value: Value) {
            this.stack.push(value);
        },
        pop() {
            if (this.stack.length === 0) {
                throw new Error("Stack underflow");
            }
            return this.stack.pop()!;
        }
    }
}

export function evaluateCode(code: string, data: CellData, runtime: Runtime): void {
    if (code.startsWith('=')) {
        code = code.slice(1);
    }

    console.log(`Evaluating code: ${code}`);
    const tokens = code.split(" ").filter(t => t.length > 0);

    const is_spreadsheet_address = (s: string): boolean => {
        let regex = /^[A-Z]+[0-9]+$/;
        return regex.test(s);
    };

    let idx = 0;
    while (idx < tokens.length) {
        const token = tokens[idx];
        if (token === '"') {
            let str = '';
            idx++;
            while (idx < tokens.length && tokens[idx] !== '"') {
                str += tokens[idx] + ' ';
                idx++;
            }
            str = str.trim();
            runtime.push({ type: "string", data: str });
        } else if (token in runtime.word_definitions) {
            const word_def = runtime.word_definitions[token];
            if (word_def.type === "native") {
                runtime.stack = word_def.word(runtime.stack);
            } else if (word_def.type === "user_defined") {
                evaluateCode(word_def.code, data, runtime);
            }
        } else if (is_spreadsheet_address(token)) {
            let value = data[cellKey(parseCellAddress(token).row, parseCellAddress(token).col)];

            if (value.raw) {
                evaluateCode(value.raw, data, runtime);
            }
        } else if (!isNaN(Number(token))) {
            runtime.push({ type: "number", data: Number(token) });
        }
        
        idx++;
    }
    console.log(runtime.stack)
}