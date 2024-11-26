# Vencord File Splitter Plugin

A Vencord plugin that bypasses Discord's 8MB file size limit by automatically splitting large files during upload and merging them back together upon download.

## Features

- Automatically splits files larger than 8MB for upload
- Seamlessly merges split files on download
- Real-time progress tracking
- Preserves original filename and metadata
- Works with any file type
- User-friendly interface

## Installation

1. Ensure you have Vencord installed
2. Copy `splitFilePlugin.tsx` to your Vencord plugins directory:
   - Windows: `%appdata%/Vencord/plugins`
   - Linux: `~/.config/Vencord/plugins`
   - macOS: `~/Library/Application Support/Vencord/plugins`
3. Restart Discord
4. Enable the "FileSplitter" plugin in Vencord settings

## Usage

1. Click the "Select Large File" button in Discord's chat
2. Choose your file
3. For files larger than 8MB:
   - The plugin automatically splits and uploads the file
   - Progress is shown for each part
4. For recipients:
   - Parts are automatically detected
   - Once all parts are received, the file is automatically merged and downloaded

## Technical Details

- Chunk Size: 7.9MB (safely under Discord's 8MB limit)
- File Format Support: All file types
- Metadata Format: JSON (includes filename, chunk number, total chunks)
- Storage Method: Base64 encoding
- Automatic chunk ordering and verification

## Important Notes

- Large files may take longer to split and merge
- Monitor memory usage when handling very large files
- All chunks must be received in the same channel for automatic merging
- Internet connection stability is important for successful uploads

## Troubleshooting

**Q: File isn't merging properly**
A: Ensure all chunks were received and are in the same channel

**Q: Upload failed mid-way**
A: Check your internet connection and try again

**Q: Plugin isn't showing up**
A: Verify the plugin is installed in the correct directory and enabled in Vencord settings

## Contributing

Contributions are welcome! Feel free to:
- Report bugs
- Suggest features
- Submit pull requests
- Improve documentation

## Security

- All file processing is done locally
- No external servers are used
- Files are split and merged on your device

## License

MIT License

## Credits

- Original project: [ImTheSquid/SplitLargeFiles](https://github.com/ImTheSquid/SplitLargeFiles)
- Ported to Vencord with additional improvements

## Requirements

- Vencord
- Discord Desktop Client
- Sufficient storage space for temporary file chunks
