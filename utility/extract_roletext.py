import sys

if len(sys.argv) < 2:
    print("No role was specified!")
    print("Useage example: $python3 extract_roletext.py Alfred")
else:
    role = sys.argv[1]

    print(f"Extracting text from {role}...")

    with open("../frontend/script.md", "r") as infile:
        lines = infile.readlines()

    out = ""

    for index, line in enumerate(lines):
        if index+1 != len(lines):
            if lines[index+1].strip() == "":
                out += line.strip()
                out += "\n"
            else:
                out += line.strip()
        else:
            out += line.strip()

    out_lines = out.split("\n")

    out_role = ""

    for out_line in out_lines:
        if out_line.startswith(f"**{role}**"):
            out_line = out_line[len(f"**{role}**"):]
            comment = False
            for character in out_line:
                if character == "*":
                    comment = not comment
                if not comment and character != "*":
                    out_role += character
            out_role += "\n"

    with open(f"{role}.md", "w") as outfile:
        outfile.write(out_role)

    print("Done!")
