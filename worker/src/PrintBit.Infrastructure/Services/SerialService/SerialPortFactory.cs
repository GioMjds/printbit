using System.IO.Ports;

namespace PrintBit.Infrastructure.Services.SerialService
{
    public static class SerialPortFactory
    {
        public static string[] GetAvailablePorts()
        {
            return SerialPort.GetPortNames();
        }
    }
}
