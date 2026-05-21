with open("../frontend/script.md", "r") as infile:
    lines = infile.readlines()

out = ""

statistics = {}

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

for out_line in out_lines:
    if out_line.startswith("**"):
        out_line = out_line[2:]
        role = out_line[:out_line.find("*")]
        out_line = out_line[out_line.find("*")+2:]
        out_line_uncommented = ""
        comment = False
        for character in out_line:
            if character == "*":
                comment = not comment
            if not comment and character != "*":
                out_line_uncommented += character
        words = len(out_line_uncommented.split(" "))
        if role in statistics.keys():
            statistics[role] += words
        else:
            statistics[role] = words

statistics_sorted = sorted(statistics.items(), key=lambda x:x[1], reverse=True)

for record in statistics_sorted:
    if len(record[0]) >= 7:
        print(f"{record[0]}:\t{record[1]}\tWörter")
    else:
        print(f"{record[0]}:\t\t{record[1]}\tWörter")
