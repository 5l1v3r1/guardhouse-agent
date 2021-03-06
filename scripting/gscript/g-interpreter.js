const Interpreter = require('../interpreter');
const GExecutor = require('./g-executor');

const logging = require('winston-color');

class GInterpreter extends Interpreter {
    static get id() {
        return 'gscript';
    }

    static get isSupported() {
        return true;
    }

    static _preProcess (scriptText) {
        // Ensure we have a trimmed script
        scriptText = scriptText.toString().trim();

        // Replace all TAB with SPACE
        scriptText = scriptText.replace(new RegExp("\\t", "g"), GInterpreter.T_SPACE);

        return scriptText;
    }

    static run (scriptText) {
        // ----- Interpreter reset -------------------------------------------------------------------------------------
        GExecutor.reset();

        // ----- Preprocess script text --------------------------------------------------------------------------------
        scriptText = GInterpreter._preProcess(scriptText);

        // ----- Set up initial state ----------------------------------------------------------------------------------
        let readingComment = false;

        let readingLiteral = false;
        let literalInEscapeSequence = false;
        let literalOpenChar = null;

        let readingVariable = false;

        let currentInstructionComponents = [];
        let interpretingInstruction = false;

        let buffer = [];
        let bufferIdx = 0;

        let contextStack = [0];
        let contextActivations = { 0: true };
        let currentContextId = 0;
        let contextIdGenerator = 1;
        let contextIsActive = true;

        let abort = false;

        // ----- Internal helper functions -----------------------------------------------------------------------------
        let _exec = function (instr, conditional) {
            // Debug log
            let logPrefix = (contextIsActive ? (conditional ? 'EXEC/CONDITIONAL' : 'EXEC') : 'EXEC/SKIP');
            let logCall = JSON.stringify(instr);

            logging.debug(`GScript ${logPrefix}: ${logCall}`);

            if (!contextIsActive) {
                // Skip instruction
                return null;
            }

            // Execute
            let execResult = GExecutor.executeCommand(instr);

            // Debug log more
            logging.debug(' RET -->', JSON.stringify(execResult.opResult));

            // Handle result
            if (execResult.abortExecution) {
                if (conditional) {
                    // Conditional abort: Treat as "ignore the block"
                    return false;
                }

                logging.warn('GScript: Abort script execution');
                abort = true;
                return false;
            }

            return !!execResult.opResult;
        };

        let _getJoinedBuffer = function () {
            return buffer.join('').trim();
        };

        let _finalizeBuffer = function (flushToInstruction) {
            if (flushToInstruction) {
                let finalizedBuffer = _getJoinedBuffer();

                if (finalizedBuffer.length) {
                    currentInstructionComponents.push(finalizedBuffer);
                    interpretingInstruction = true;
                }
            }

            buffer = [];
            bufferIdx = 0;

            readingComment = false;
            readingLiteral = false;

            literalInEscapeSequence = false;
            literalOpenChar = null;
        };

        let _eatBuffer = function () {
            let bufferStr = buffer.join('');
            _finalizeBuffer(false);
            return bufferStr;
        };

        let _finalizeInstructionToExec = function (conditional) {
            let execReturnValue = false;

            if (interpretingInstruction) {
                execReturnValue = _exec(currentInstructionComponents, !!conditional);
            } else {
                Logger.debug('GScript: EXEC_NOOP_BLANK');
            }

            currentInstructionComponents = [];
            interpretingInstruction = false;

            return execReturnValue;
        };

        // ----- Begin token parsing -----------------------------------------------------------------------------------
        for (let i = 0; i < scriptText.length; i++) {
            if (abort) {
                break;
            }

            let char = scriptText[i];
            let lastChar = null;

            if (buffer.length) {
                lastChar = buffer[bufferIdx - 1];
            }

            if (!readingLiteral) {
                // When parsing non-literals, ignore certain chars:
                // - SPACE: Any repeating spaces are of no value to us
                // - RETURN: We discard any carriage returns (\r); we only use

                if ((lastChar === GInterpreter.T_SPACE && char === GInterpreter.T_SPACE) ||
                    char === GInterpreter.T_RETURN) {
                    continue;
                }
            }

            if (readingVariable) {
                // MODE: Reading a variable name literal until we encounter a variable-breaking char (space, semicolon)
                if (char === GInterpreter.T_SPACE || char === GInterpreter.T_INSTRUCTION_END) {
                    // End of variable reference, break out of read mode and gather data
                    readingLiteral = false;

                    let variableName =  _eatBuffer();

                    // Check reference and get variable value
                    let variablePrefix = GInterpreter.T_VARIABLE_INDICATOR;
                    let variableValue = GExecutor.getVariable(variableName);

                    if (typeof variableValue === "undefined") {
                        throw new Error(`Reference error. Referenced variable ${variablePrefix}${variableName} is not defined.`);
                    }

                    // Insert the variable as a literal in the call we are preparing
                    currentInstructionComponents.push(variableValue);

                    // If the character also happened
                    let forceInstructionEnd = (char === GInterpreter.T_INSTRUCTION_END);

                    if (forceInstructionEnd) {
                        _finalizeInstructionToExec();
                    }

                    continue;
                }
            }
            else if (readingLiteral) {
                // MODE: Reading a string literal until we encounter a termination char (unescaped quotes)
                if (literalInEscapeSequence) {
                    // Do not interpret this character
                    literalInEscapeSequence = false;
                } else {
                    if (char === GInterpreter.T_ESCAPE) {
                        // Ignore the escape itself, and treat the next character as a literal (do not interpet next char)
                        literalInEscapeSequence = true;
                        continue;
                    } else if (char === literalOpenChar) {
                        // We encountered a non-escaped char matching the literal opening char
                        // This means we are now ending the literal read (+ ignore the actual char)
                        readingLiteral = false;
                        _finalizeBuffer(true);
                        continue;
                    }
                }
            } else if (readingComment) {
                // MODE: Reading a comment until we encounter a newline
                if (char === GInterpreter.T_NEW_LINE) {
                    _finalizeBuffer(false);
                    continue;
                }
            } else {
                // MODE: Free interpretation
                if (char === GInterpreter.T_INSTRUCTION_END) {
                    // INSTRUCTION TERMINATOR: Flush instruction
                    _finalizeBuffer(true);
                    _finalizeInstructionToExec();
                    continue;
                } else if (char === GInterpreter.T_NEW_LINE) {
                    // NEW LINE CHAR: Interpret as a space character, it has no value beyond a separator
                    char = ' ';

                    if (lastChar === GInterpreter.T_SPACE) {
                        // Do not put double spaces in my buffer
                        continue;
                    }
                } else if (char === GInterpreter.T_COMMENT) {
                    // COMMENT INDICATOR: Begin reading a comment string (they are allowed anywhere on a line)
                    if (interpretingInstruction) {
                        throw new Error('Syntax error. Unexpected "#": cannot start a comment within an instruction.');
                    }

                    readingComment = true;
                    continue;
                } else if (char === GInterpreter.T_CONTEXT_OPEN) {
                    // CONTEXT OPEN: Begin a context block, which should have been preceded by an instruction
                    if (!interpretingInstruction) {
                        throw new Error('Syntax error. Unexpected "{" - no preceding conditional statement.')
                    }

                    // Treat the "context open" as an end-of-instruction marker
                    // We'll execute the instruction as a "conditional" and get a return value from it
                    let returnValue = _finalizeInstructionToExec(true);

                    // If the return value evaluates to true, we'll "activate" the context
                    // Otherwise, the context will still be interpreted but its instructions will not be executed
                    let newContextId = contextIdGenerator++;
                    let newContextActive = !!returnValue;

                    // Push context data to execution stack
                    contextStack.push(currentContextId);
                    contextActivations[newContextId] = newContextActive;

                    currentContextId = newContextId;
                    contextIsActive = newContextActive;

                    logging.debug(`GScript CNTX: <--- Enter [${newContextId}] - Activated: ${contextIsActive}`);
                    _finalizeBuffer(false);
                    continue;
                } else if (char === GInterpreter.T_CONTEXT_CLOSE) {
                    // CONTEXT CLOSE: Close a context block, which should have been preceded by an instruction
                    if (!contextStack.length) {
                        throw new Error('Syntax error. Unexpected "}" - not in a context block.')
                    }

                    // Go back to the previous context
                    let oldContextId = currentContextId;
                    let newContextId = contextStack.pop();

                    currentContextId = newContextId;
                    contextIsActive = contextActivations[newContextId];

                    logging.debug(`GScript CNTX: ---> Close [${oldContextId}], return to [${newContextId}] - Activated: ${contextIsActive}`);

                    _finalizeBuffer(false);
                    continue;
                } else if (char === GInterpreter.T_STRING_DOUBLE_QUOTE || char === GInterpreter.T_STRING_SINGLE_QUOTE) {
                    // QUOTE CHARACTER: Start reading a literal
                    readingLiteral = true;
                    literalOpenChar = char;
                    continue;
                } else if (char === GInterpreter.T_SPACE) {
                    // SPACE CHAR: Separates a parameter or instruction component
                    _finalizeBuffer(true);
                    continue;
                } else if (char === GInterpreter.T_VARIABLE_INDICATOR) {
                    // VARIABLE PREFIX: Start reading a variable
                    if (bufferIdx === 0) {
                        readingVariable = true;
                    } else {
                        throw new Error('Syntax error. Unexpected variable declaration.');
                    }

                    continue;
                }
            }

            // Write to buffer
            buffer.push(char);
            bufferIdx++;
        }

        // ----- Evaluate state ----------------------------------------------------------------------------------------
        if ((buffer.length || interpretingInstruction) && !readingComment && !abort) {
            // Buffer is not empty, that means certain characters were not interpreted by us

            // To clarify: After we process an instruction, we call "_finalizeBuffer" which emptes it.
            // If the buffer is nonempty, that means something was not processed.

            // This usually indicates an instruction or literal that was not terminated correctly.

            if (readingLiteral) {
                throw new Error('Syntax error: Unexpected end of script - unterminated string literal. Did you forget a closing quote character?');
            }

            throw new Error('Syntax error: Unexpected end of script - unterminated instruction. Did you forget a semicolon (;)?');
        }
    }
}

GInterpreter.T_SPACE = ' ';
GInterpreter.T_COMMENT = '#';
GInterpreter.T_CONTEXT_OPEN = '{';
GInterpreter.T_CONTEXT_CLOSE = '}';
GInterpreter.T_INSTRUCTION_END = ';';
GInterpreter.T_STRING_DOUBLE_QUOTE = '"';
GInterpreter.T_STRING_SINGLE_QUOTE = "'";
GInterpreter.T_RETURN = "\r";
GInterpreter.T_NEW_LINE = "\n";
/**
 * Escape characters can be used inside literals to force the interpreter to never interpret the character following it.
 *
 * Example: A literal containing `I like \"poop\"` would be interpreted as `I like "poop"`
 * Example: A literal containing `I escape \\ twice` would be interpreted as `I escape \ twice`;
 * Example: A literal containing `I escape \\\\\\\ lots` would be interpreted as `I escape \\\ lots`
 */
GInterpreter.T_ESCAPE = "\\";
/**
 * Variable indicators can be used to insert runtime variables as literals into instruction calls.
 *
 * Example: Executing "echo $bla;" would result in the value of runtime variable "bla" being inserted as a literal
 *      in the place of the "$bla" marker.
 *
 * @see GExecutor
 */
GInterpreter.T_VARIABLE_INDICATOR = '$';

module.exports = GInterpreter;