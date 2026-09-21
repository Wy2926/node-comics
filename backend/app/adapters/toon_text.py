"""TOON string-table subset for LLM dialogue, not a general TOON decoder.

Reference: https://github.com/toon-format/spec/blob/main/SPEC.md (4.1).
Only comma-delimited, two-column tables with string cells are accepted.
"""
import json
import re


def quoted(value):
    return (not value or value != value.strip() or value in ('true', 'false', 'null')
            or value.startswith(('-', '#')) or re.fullmatch(r'[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?', value)
            or any(c in ',:"\\[]{}' or ord(c) < 32 for c in value))


def cell(value):
    return json.dumps(value, ensure_ascii=False) if quoted(value) else value


def table(name, fields, rows):
    return '\n'.join([f'{name}[{len(rows)}]{{{fields}}}:',
                      *('  ' + ','.join(cell(v) for v in row) for row in rows)])


def read_row(line):
    if not line.startswith('  ') or line.startswith('   '):
        raise ValueError('Invalid indentation')
    source, values = line[2:], []
    while True:
        source = source.lstrip(' ')
        if source.startswith('"'):
            # TOON permits these string escapes, but not JSON's optional \/.
            match = re.match(r'"(?:[^"\\\x00-\x1f]|\\(?:["\\nrt]|u[0-9a-fA-F]{4}))*"', source)
            if not match:
                raise ValueError('Invalid string escape')
            value = json.loads(match[0])
            source = source[match.end():].lstrip(' ')
        else:
            value, separator, rest = source.partition(',')
            value = value.strip(' ')
            if quoted(value):
                raise ValueError('Expected quoted string')
            source = separator + rest
        values.append(value)
        if not source:
            break
        if not source.startswith(',') or len(values) >= 2:
            raise ValueError('Invalid row width')
        source = source[1:]
    if len(values) != 2:
        raise ValueError('Invalid row width')
    return values
