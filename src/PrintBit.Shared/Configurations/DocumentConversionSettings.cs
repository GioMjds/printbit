namespace PrintBit.Shared.Configurations;

public sealed class DocumentConversionSettings
{
    public string SofficePath { get; set; } = @"C:\Program Files\LibreOffice\program\soffice.exe";
    public int DefaultTimeoutSeconds { get; set; } = 60;
    public string PipeName { get; set; } = "printbit-document-conversion";
    public string UserProfileDirectory { get; set; } = @"C:\ProgramData\PrintBit\lo-profile";
    public string DefaultOutputDirectory { get; set; } = @"C:\ProgramData\PrintBit\converted";
}
