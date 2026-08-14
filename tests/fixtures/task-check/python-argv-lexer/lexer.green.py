def parse_argv(line: str) -> list[str]:
    arguments: list[str] = []
    current: list[str] = []
    quoted = False
    escaped = False
    started = False

    for character in line:
        if escaped:
            current.append(character)
            escaped = False
            started = True
        elif character == "\\":
            escaped = True
            started = True
        elif character == '"':
            quoted = not quoted
            started = True
        elif character.isspace() and not quoted:
            if started:
                arguments.append("".join(current))
                current.clear()
                started = False
        else:
            current.append(character)
            started = True

    if escaped or quoted:
        raise ValueError("malformed argv")
    if started:
        arguments.append("".join(current))
    return arguments
