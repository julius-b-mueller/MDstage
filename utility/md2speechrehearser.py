with open("../frontend/dist/script.md", "r") as infile:
    lines = infile.readlines()

output = ""
current_scene = 1

for index, line in enumerate(lines):
    # Roles
    if line[:2] == "**":
        line = line.strip()[2:-2].upper()
        output += line.strip() + "\n"
    # Actions
    elif line[0] == "*":
        line = "(" + line.strip()[1:-1] + ")"
        if index + 1 < len(lines):
            if lines[index+1].strip() == "":
                output += line.strip() + "\n\n"
            else:
                output += line.strip() + " "
        else:
            output += line.strip() + "\n"
    # Scenes
    elif line[0] == "#":
        while line[0] == "#":
            line = line[1:]
        line = f"Scene {current_scene} " + line[1:].strip()
        output += line.strip() + "\n\n"
        current_scene += 1
    # text
    elif index + 1 < len(lines):
        if lines[index+1].strip() == "":
            output += line.strip() + "\n\n"
        elif line.strip() != "":
            output += line.strip() + " "
        else:
            output += line.strip()
    else:
        output += line.strip() + "\n"

with open("script.txt", "w") as outfile:
    outfile.write(output)

# TODO: remove yaml parts from md script
# TODO: remove title, only take ## as scenes
